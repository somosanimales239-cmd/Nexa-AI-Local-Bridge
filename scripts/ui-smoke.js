'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = process.cwd();
const artifactsDir = path.join(root, 'artifacts');
const reportPath = path.join(artifactsDir, 'ui-smoke-report.json');
const failurePath = path.join(artifactsDir, 'ui-smoke-failure.txt');
const startedAt = new Date().toISOString();
const diagnostics = [];
let finalizing = false;
let timeoutHandle = null;

fs.mkdirSync(artifactsDir, { recursive: true });
process.env.NEXA_UI_SMOKE = '1';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-ui-smoke-')));

const record = (type, detail) => {
  const value = detail instanceof Error ? (detail.stack || detail.message) : String(detail ?? '');
  diagnostics.push({ type, detail: value.slice(0, 4000), at: new Date().toISOString() });
};

const writeReport = (result, extra = {}) => {
  const report = {
    result,
    applicationVersion: packageJson.version || null,
    productName: packageJson.build?.productName || packageJson.productName || packageJson.name || null,
    main: packageJson.main || 'main.js',
    commitSha: process.env.GITHUB_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    startedAt,
    finishedAt: new Date().toISOString(),
    diagnostics,
    ...extra,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
};

const closeAndExit = async (code, result, extra = {}) => {
  if (finalizing) return;
  finalizing = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  try { writeReport(result, extra); } catch (error) { record('report-write-error', error); code = 1; }
  for (const window of BrowserWindow.getAllWindows()) {
    try { window.destroy(); } catch (error) { record('window-destroy-error', error); }
  }
  try { app.quit(); } catch (error) { record('app-quit-error', error); }
  setTimeout(() => process.exit(code), 150).unref();
};

const fail = async error => {
  record('failure', error);
  try { fs.writeFileSync(failurePath, `${diagnostics.map(item => `${item.type}: ${item.detail}`).join('\n')}\n`, 'utf8'); } catch (_) {}
  await closeAndExit(1, 'failure', { error: error?.message || String(error) });
};

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (error) {
  console.error(error);
  process.exit(1);
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (...args) => {
    const details = args[1];
    const level = details && typeof details === 'object' ? details.level : args[1];
    const message = details && typeof details === 'object' ? details.message : args[2];
    if (Number(level) >= 2) record('renderer-console', message || 'Unknown renderer console message');
  });
  contents.on('preload-error', (_event, preloadPath, error) => record('preload-error', `${preloadPath}: ${error?.stack || error}`));
  contents.on('render-process-gone', (_event, details) => record('render-process-gone', JSON.stringify(details || {})));
});

const waitForWindow = async timeoutMs => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    if (windows.length) return windows[0];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Electron did not create a BrowserWindow within the smoke-test timeout.');
};

const waitForRenderer = async (window, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error('The application window was destroyed before renderer-ready.');
    if (!window.webContents.isLoadingMainFrame()) {
      const state = await window.webContents.executeJavaScript('document.readyState', true).catch(() => 'loading');
      if (state === 'interactive' || state === 'complete') return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The renderer did not reach an interactive state within the smoke-test timeout.');
};

try {
  const mainPath = path.resolve(root, packageJson.main || 'main.js');
  if (!fs.existsSync(mainPath)) throw new Error(`Electron main entry is missing: ${path.relative(root, mainPath)}`);
  require(mainPath);
} catch (error) {
  fail(error);
}

timeoutHandle = setTimeout(() => fail(new Error('Electron UI smoke timed out after 30 seconds.')), 30000);

app.whenReady().then(async () => {
  const window = await waitForWindow(15000);
  await waitForRenderer(window, 15000);
  const probe = await window.webContents.executeJavaScript(String.raw`(() => {
    const bodyText = document.body?.innerText?.trim() || '';
    const contracts = Array.from(document.querySelectorAll('[data-testid],[data-nexa-action],[data-nexa-contract]'))
      .slice(0, 250)
      .map(element => ({
        testid: element.getAttribute('data-testid'),
        action: element.getAttribute('data-nexa-action'),
        contract: element.getAttribute('data-nexa-contract')
      }));
    return {
      readyState: document.readyState,
      title: document.title || '',
      bodyTextLength: bodyText.length,
      hasBody: Boolean(document.body),
      hasNexaBridge: Boolean(window.nexa),
      exposesGenericIpcRenderer: Boolean(window.nexa && window.nexa.ipcRenderer),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      contracts
    };
  })()`, true);

  if (!probe.hasBody || probe.bodyTextLength < 20) throw new Error('The renderer loaded without usable application content.');
  if (!probe.title) throw new Error('The renderer loaded without a document title.');
  if (probe.exposesGenericIpcRenderer) throw new Error('The preload exposes a generic ipcRenderer contract.');

  const fatalDiagnostics = diagnostics.filter(item => ['preload-error', 'render-process-gone'].includes(item.type));
  if (fatalDiagnostics.length) throw new Error('Electron reported a preload or renderer-process failure.');

  await closeAndExit(0, 'success', {
    rendererReady: true,
    title: probe.title,
    bodyTextLength: probe.bodyTextLength,
    hasNexaBridge: probe.hasNexaBridge,
    horizontalOverflow: probe.horizontalOverflow,
    semanticContracts: probe.contracts,
  });
}).catch(fail);