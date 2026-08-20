'use strict';

const path = require('path');
const {
  app, BrowserWindow, ipcMain, shell, safeStorage, Tray, Menu
} = require('electron');

const { SecureConfig } = require('./src/services/secure-config');
const { SafeLogger } = require('./src/services/logger');
const { collectSystemInfo } = require('./src/services/system-info');
const { BridgePolicy } = require('./src/services/policy');
const {
  validateEndpoint, deriveCommandEndpoint, pollCommand,
  submitCommandResult, submitCommandError, submitCommandCancelled,
  sendHeartbeat, sendServerLog
} = require('./src/services/bridge-client');
const { executeReadOnlyCommand } = require('./src/services/read-only-executor');

const HEARTBEAT_MS = 20_000;
const COMMAND_POLL_MS = 5_000;
const RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000];

let mainWindow = null;
let tray = null;
let configStore = null;
let logger = null;
let heartbeatTimer = null;
let commandTimer = null;
let commandBusy = false;
let retryIndex = 0;
let systemInfo = null;
let quitting = false;

const policy = new BridgePolicy();
const activity = [];

const state = {
  status: 'unpaired',
  statusMessage: 'Pair this PC with your Hostinger control center.',
  connected: false,
  lastHeartbeat: '',
  serverTime: '',
  endpoint: '',
  deviceLabel: '',
  pcName: '',
  osName: '',
  localIp: '',
  gpu: '',
  version: app.getVersion(),
  autoConnect: false,
  startWithWindows: false,
  paired: false,
  allowedRoots: [],
  commandEndpoint: '',
  currentCommand: null,
  policy: policy.snapshot(),
  activity,
};

function safeActivity(level, event, message) {
  const row = logger
    ? logger.log(level, event, message)
    : { timestamp: new Date().toISOString(), level, event, message: String(message || '') };
  activity.unshift(row);
  if (activity.length > 30) activity.length = 30;
  broadcastState();
}

function publicState() {
  return JSON.parse(JSON.stringify(state));
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bridge:state', publicState());
  }
  refreshTray();
}

function updateConfigState() {
  const cfg = configStore.publicConfig();
  state.endpoint = cfg.endpoint;
  state.deviceLabel = cfg.deviceLabel;
  state.autoConnect = cfg.autoConnect;
  state.startWithWindows = cfg.startWithWindows;
  state.paired = cfg.paired;
  state.allowedRoots = Array.isArray(cfg.allowedRoots) ? cfg.allowedRoots : [];
  if (!cfg.paired && !state.connected) state.status = 'unpaired';
}

function applyPolicy(serverState) {
  const before = policy.snapshot();
  policy.applyServerState(serverState);
  state.policy = policy.snapshot();
  state.serverTime = serverState.server_time || '';
  if (serverState.command_endpoint) state.commandEndpoint = serverState.command_endpoint;

  if (before.emergencyStop !== state.policy.emergencyStop) {
    safeActivity(
      state.policy.emergencyStop ? 'danger' : 'warning',
      'security',
      state.policy.emergencyStop ? 'Emergency Stop activated by Hostinger.' : 'Emergency Stop released by Hostinger.'
    );
  }
  const changedPermissions = Object.keys(state.policy.permissions).filter(
    key => before.permissions?.[key] !== state.policy.permissions[key]
  );
  if (changedPermissions.length) {
    safeActivity('info', 'permissions', `Server permission state changed: ${changedPermissions.join(', ')}.`);
  }
}

function stopTimer() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function stopCommandTimer() {
  if (commandTimer) clearTimeout(commandTimer);
  commandTimer = null;
}

function scheduleCommandPoll(delayMs = COMMAND_POLL_MS) {
  stopCommandTimer();
  if (!state.paired || !state.connected) return;
  commandTimer = setTimeout(() => {
    commandCycle().catch(error => {
      safeActivity('warning', 'command-queue', `Command polling error: ${error.message}`);
      scheduleCommandPoll(10_000);
    });
  }, delayMs);
}

function scheduleHeartbeat(delayMs) {
  stopTimer();
  heartbeatTimer = setTimeout(() => {
    heartbeatCycle().catch(error => handleHeartbeatFailure(error));
  }, delayMs);
}

function tokenForConnection(candidate) {
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  return configStore.getToken();
}

async function heartbeatOnce({ endpoint, token }) {
  if (!systemInfo) systemInfo = await collectSystemInfo(app.getVersion());
  const response = await sendHeartbeat(endpoint, token, systemInfo);
  applyPolicy(response);

  state.connected = true;
  state.status = response.bridge_enabled ? 'connected' : 'cloud-disabled';
  state.statusMessage = response.bridge_enabled
    ? 'Secure heartbeat accepted by Hostinger.'
    : 'The Hostinger bridge policy is disabled.';
  state.lastHeartbeat = new Date().toISOString();
  state.pcName = systemInfo.pc_name;
  state.osName = systemInfo.os_name;
  state.localIp = systemInfo.local_ip;
  state.gpu = systemInfo.gpu;
  retryIndex = 0;
  broadcastState();
  if (!commandTimer && !commandBusy) scheduleCommandPoll(1000);
  return response;
}

async function heartbeatCycle() {
  if (!state.paired) return;
  const cfg = configStore.publicConfig();
  const token = configStore.getToken();
  await heartbeatOnce({ endpoint: cfg.endpoint, token });
  scheduleHeartbeat(HEARTBEAT_MS);
}

function handleHeartbeatFailure(error) {
  policy.markDisconnected();
  state.policy = policy.snapshot();
  state.connected = false;

  if (error?.code === 'AUTH_REJECTED') {
    stopTimer();
    state.status = 'auth-failed';
    state.statusMessage = error.message;
    safeActivity('danger', 'auth', error.message);
    return;
  }

  if (error?.code === 'BRIDGE_DISABLED') {
    state.status = 'cloud-disabled';
    state.statusMessage = error.message;
    safeActivity('warning', 'bridge', error.message);
  } else {
    state.status = 'reconnecting';
    state.statusMessage = error?.message || 'Connection lost. Reconnecting.';
    safeActivity('warning', 'network', state.statusMessage);
  }

  const delay = RETRY_DELAYS[Math.min(retryIndex, RETRY_DELAYS.length - 1)];
  retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
  scheduleHeartbeat(delay);
}

async function connectInternal(payload, savePairing) {
  const endpoint = validateEndpoint(payload?.endpoint || configStore.publicConfig().endpoint);
  const token = tokenForConnection(payload?.token);
  if (!token) throw new Error('Enter the pairing token generated by the Hostinger dashboard.');

  const deviceLabel = String(payload?.deviceLabel || configStore.publicConfig().deviceLabel || 'Main Windows PC').trim().slice(0, 100);
  state.status = 'connecting';
  state.statusMessage = 'Authenticating with Hostinger…';
  broadcastState();

  const response = await heartbeatOnce({ endpoint, token });

  if (savePairing) {
    const current = configStore.publicConfig();
    configStore.savePairing({
      endpoint,
      deviceLabel,
      token,
      autoConnect: payload?.autoConnect === undefined ? current.autoConnect : payload.autoConnect === true,
      startWithWindows: payload?.startWithWindows === undefined ? current.startWithWindows : payload.startWithWindows === true,
      allowedRoots: Array.isArray(payload?.allowedRoots) ? payload.allowedRoots : current.allowedRoots,
    });
    updateConfigState();
    applyLoginPreference(state.startWithWindows);
  }

  stopTimer();
  scheduleHeartbeat(HEARTBEAT_MS);
  safeActivity('info', 'connection', 'Nexa AI Local Bridge authenticated and heartbeat was accepted.');
  sendServerLog(endpoint, token, 'info', `Nexa AI Local Bridge connected from ${systemInfo?.pc_name || 'Windows PC'}.`).catch(() => {});
  return { ok: true, response, state: publicState() };
}


async function commandCycle() {
  stopCommandTimer();
  if (commandBusy || !state.paired || !state.connected) return;
  if (!policy.canExecute('read_files')) {
    scheduleCommandPoll(COMMAND_POLL_MS);
    return;
  }

  let nextPollDelay = COMMAND_POLL_MS;
  commandBusy = true;
  try {
    const cfg = configStore.publicConfig();
    const token = configStore.getToken();
    const endpoint = state.commandEndpoint || deriveCommandEndpoint(cfg.endpoint);
    const polled = await pollCommand(endpoint, token);
    const command = polled.command;
    if (!command) return;
    nextPollDelay = 1000;

    state.currentCommand = { uuid: command.uuid, action: command.action, status: 'running' };
    safeActivity('info', 'command', `Running read-only command ${command.action} (${command.uuid}).`);
    broadcastState();

    if (command.cancel_requested) {
      await submitCommandCancelled(endpoint, token, command.uuid);
      safeActivity('warning', 'command', `Command cancelled before execution (${command.uuid}).`);
      return;
    }

    try {
      const result = await executeReadOnlyCommand(command, {
        policy,
        systemInfo,
        allowedRoots: configStore.publicConfig().allowedRoots,
      });
      if (result && result.cancelled) {
        await submitCommandCancelled(endpoint, token, command.uuid);
      } else {
        await submitCommandResult(endpoint, token, command.uuid, result);
      }
      safeActivity('info', 'command', `Command completed: ${command.action} (${command.uuid}).`);
    } catch (error) {
      await submitCommandError(endpoint, token, command.uuid, error.message);
      safeActivity('warning', 'command', `Command failed: ${command.action}: ${error.message}`);
    }
  } finally {
    state.currentCommand = null;
    commandBusy = false;
    broadcastState();
    scheduleCommandPoll(nextPollDelay);
  }
}

function disconnectInternal() {
  stopTimer();
  stopCommandTimer();
  policy.markDisconnected();
  state.policy = policy.snapshot();
  state.connected = false;
  state.status = state.paired ? 'offline' : 'unpaired';
  state.statusMessage = state.paired
    ? 'Disconnected locally. Pairing remains saved.'
    : 'Pair this PC with your Hostinger control center.';
  safeActivity('info', 'connection', 'Bridge disconnected locally.');
}

function applyLoginPreference(enabled) {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled === true,
      path: process.execPath,
      args: [],
    });
  } catch (error) {
    safeActivity('warning', 'startup', `Unable to change Start with Windows: ${error.message}`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 940,
    minHeight: 650,
    backgroundColor: '#050b14',
    show: false,
    title: 'Nexa AI Local Bridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', event => {
    if (process.platform === 'win32' && state.paired && !quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function ensureTray() {
  if (process.platform !== 'win32' || tray) return;
  const iconPath = path.join(__dirname, 'src', 'assets', 'tray.png');
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('Nexa AI Local Bridge');
    tray.on('double-click', () => {
      if (!mainWindow) createWindow();
      mainWindow.show();
      mainWindow.focus();
    });
    refreshTray();
  } catch (error) {
    safeActivity('warning', 'tray', `System tray could not start: ${error.message}`);
  }
}

function refreshTray() {
  if (!tray) return;
  const status = state.status.replace('-', ' ');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Nexa AI Local Bridge', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: `Status: ${status}`, enabled: false },
    { type: 'separator' },
    { label: 'Reconnect', enabled: state.paired, click: () => {
      state.status = 'reconnecting';
      state.statusMessage = 'Manual reconnect requested.';
      heartbeatCycle().catch(error => handleHeartbeatFailure(error));
    }},
    { label: 'Disconnect', enabled: state.connected, click: () => disconnectInternal() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; stopTimer(); stopCommandTimer(); app.quit(); } },
  ]));
}

ipcMain.handle('bridge:get-state', () => publicState());

ipcMain.handle('bridge:test', async (_event, payload) => {
  try {
    const endpoint = validateEndpoint(payload?.endpoint || configStore.publicConfig().endpoint);
    const token = tokenForConnection(payload?.token);
    if (!token) throw new Error('Enter a pairing token before testing.');
    if (!systemInfo) systemInfo = await collectSystemInfo(app.getVersion());
    const response = await sendHeartbeat(endpoint, token, systemInfo);
    safeActivity('info', 'test', 'Connection test passed: endpoint, authentication and heartbeat accepted.');
    return {
      ok: true,
      stages: {
        endpointReached: true,
        authenticationAccepted: true,
        heartbeatAccepted: true,
        policyReceived: true,
      },
      response,
    };
  } catch (error) {
    safeActivity('warning', 'test', `Connection test failed: ${error.message}`);
    return { ok: false, error: error.message, code: error.code || 'ERROR' };
  }
});

ipcMain.handle('bridge:connect', async (_event, payload) => {
  try {
    return await connectInternal(payload || {}, true);
  } catch (error) {
    handleHeartbeatFailure(error);
    return { ok: false, error: error.message, code: error.code || 'ERROR' };
  }
});

ipcMain.handle('bridge:disconnect', () => {
  disconnectInternal();
  return { ok: true, state: publicState() };
});

ipcMain.handle('bridge:reconnect', async () => {
  if (!state.paired) return { ok: false, error: 'This PC is not paired.' };
  try {
    return await connectInternal({}, false);
  } catch (error) {
    handleHeartbeatFailure(error);
    return { ok: false, error: error.message, code: error.code || 'ERROR' };
  }
});

ipcMain.handle('bridge:update-preferences', (_event, payload) => {
  const next = configStore.updatePreferences({
    autoConnect: payload?.autoConnect,
    startWithWindows: payload?.startWithWindows,
    allowedRoots: Array.isArray(payload?.allowedRoots) ? payload.allowedRoots : undefined,
  });
  updateConfigState();
  applyLoginPreference(next.startWithWindows);
  safeActivity('info', 'preferences', 'Local preferences updated.');
  return { ok: true, state: publicState() };
});

ipcMain.handle('bridge:unpair', () => {
  disconnectInternal();
  configStore.clearPairing();
  policy.reset();
  state.policy = policy.snapshot();
  updateConfigState();
  state.endpoint = '';
  state.deviceLabel = '';
  state.allowedRoots = [];
  state.commandEndpoint = '';
  state.currentCommand = null;
  state.status = 'unpaired';
  state.statusMessage = 'Pairing removed from this PC.';
  safeActivity('warning', 'pairing', 'This PC was unpaired and the stored token was cleared.');
  return { ok: true, state: publicState() };
});

ipcMain.handle('bridge:open-logs', () => {
  if (!logger) return { ok: false };
  shell.openPath(logger.logDir);
  return { ok: true };
});

app.whenReady().then(async () => {
  logger = new SafeLogger(path.join(app.getPath('userData'), 'logs'));
  configStore = new SecureConfig({ userDataPath: app.getPath('userData'), safeStorage });
  updateConfigState();

  state.version = app.getVersion();
  systemInfo = await collectSystemInfo(app.getVersion());
  state.pcName = systemInfo.pc_name;
  state.osName = systemInfo.os_name;
  state.localIp = systemInfo.local_ip;
  state.gpu = systemInfo.gpu;

  safeActivity('info', 'app', `Nexa AI Local Bridge ${app.getVersion()} started.`);
  createWindow();
  ensureTray();
  applyLoginPreference(state.startWithWindows);

  if (state.paired && state.autoConnect) {
    connectInternal({}, false).catch(error => handleHeartbeatFailure(error));
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  stopTimer();
  stopCommandTimer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'win32') app.quit();
});
