'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const secureConfigSource = fs.readFileSync(path.join(root, 'src/services/secure-config.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'src/services/bridge-client.js'), 'utf8');
const loggerSource = fs.readFileSync(path.join(root, 'src/services/logger.js'), 'utf8');
const { BridgePolicy } = require(path.join(root, 'src/services/policy.js'));

test('Electron package has a valid active entry graph', () => {
  assert.match(String(packageJson.version || ''), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.ok(fs.existsSync(path.join(root, packageJson.main || 'main.js')));
  assert.equal(typeof packageJson.scripts?.['ui:smoke'], 'string');
  assert.equal(typeof packageJson.scripts?.['validate:delivery'], 'string');
});

test('Electron security isolation is explicitly enabled', () => {
  assert.match(mainSource, /contextIsolation\s*:\s*true/);
  assert.match(mainSource, /nodeIntegration\s*:\s*false/);
  assert.doesNotMatch(mainSource, /webSecurity\s*:\s*false/);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*ipcRenderer/);
  assert.doesNotMatch(preloadSource, /ipcRenderer\s*:/);
});

test('pairing token is not stored in renderer localStorage or plaintext config', () => {
  assert.doesNotMatch(rendererSource, /localStorage/);
  assert.match(secureConfigSource, /safeStorage\.encryptString/);
  assert.match(secureConfigSource, /safeStorage\.decryptString/);
  assert.doesNotMatch(secureConfigSource, /token\s*:\s*token/);
});

test('heartbeat is authenticated POST JSON', () => {
  assert.match(clientSource, /method:\s*'POST'/);
  assert.match(clientSource, /Authorization/);
  assert.match(clientSource, /Bearer \$\{token\}/);
  assert.match(clientSource, /action:\s*'heartbeat'/);
});

test('production endpoint validation requires HTTPS', () => {
  assert.match(clientSource, /Production Agent Endpoint must use HTTPS/);
});

test('heartbeat scheduler and bounded reconnect delays exist', () => {
  assert.match(mainSource, /HEARTBEAT_MS\s*=\s*20_000/);
  assert.match(mainSource, /RETRY_DELAYS\s*=\s*\[2_000,\s*5_000,\s*10_000,\s*20_000,\s*30_000\]/);
  assert.match(mainSource, /stopTimer\(\)/);
});

test('policy blocks execution readiness under security gates', () => {
  const policy = new BridgePolicy();
  policy.applyServerState({
    bridge_enabled: true,
    emergency_stop: false,
    full_computer_mode: false,
    permissions: { read_files: true },
  });
  assert.equal(policy.canExecute('read_files'), true);
  assert.equal(policy.canExecute('cmd'), false);

  policy.applyServerState({
    bridge_enabled: true,
    emergency_stop: true,
    full_computer_mode: true,
    permissions: { read_files: true },
  });
  assert.equal(policy.canExecute('read_files'), false);

  policy.applyServerState({
    bridge_enabled: false,
    emergency_stop: false,
    full_computer_mode: false,
    permissions: { read_files: true },
  });
  assert.equal(policy.canExecute('read_files'), false);

  policy.markDisconnected();
  assert.equal(policy.canExecute('read_files'), false);
});

test('renderer contains real security and pairing controls', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.match(html, /Emergency Stop/i);
  assert.match(rendererSource, /Read Files/i);
  assert.match(rendererSource, /PowerShell/i);
  assert.match(html, /Test Connection/i);
  assert.match(html, /Unpair this PC/i);
});

test('local logger redacts bearer and Nexa pairing token patterns', () => {
  assert.match(loggerSource, /PAIRING_TOKEN_REDACTED/);
  assert.match(loggerSource, /Bearer \[REDACTED\]/);
});

test('Start with Windows defaults off in an unconfigured installation', () => {
  assert.match(secureConfigSource, /startWithWindows:\s*raw\.startWithWindows\s*===\s*true/);
});


test('read-only command queue client and executor are present without arbitrary shell execution', () => {
  const client = fs.readFileSync(path.join(root, 'src/services/bridge-client.js'), 'utf8');
  const executor = fs.readFileSync(path.join(root, 'src/services/read-only-executor.js'), 'utf8');
  assert.match(client, /pollCommand/);
  assert.match(client, /submitCommandResult/);
  assert.match(executor, /list_directory/);
  assert.match(executor, /read_file/);
  assert.match(executor, /Blocked by local Allowed Folders policy/);
  assert.doesNotMatch(executor, /exec\s*\(/);
  assert.doesNotMatch(executor, /shell\s*:\s*true/);
});

test('renderer exposes Allowed Folders and remote queue state', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.match(html, /Allowed Folders/i);
  assert.match(html, /Current Hostinger command/i);
  assert.match(rendererSource, /allowedRoots/);
});
