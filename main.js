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
const { executeSingleRemoteCommand, executeRemoteEnvelope } = require('./src/services/remote-executor');
const { RemoteCommandInbox, testPop3Mailbox } = require('./src/services/remote-command-inbox');
const { deriveWorkspaceEndpoint } = require('./src/services/workspace-client');
const { syncUnityProject, installUnityIntegration, requestUnityCapture } = require('./src/services/unity-workspace');
const { validateRepo, validateBranch, testGithubConnection, publishGithubWorkspaces } = require('./src/services/github-workspace');

const HEARTBEAT_MS = 20_000;
const COMMAND_POLL_MS = 5_000;
const WORKSPACE_SYNC_MS = 90_000;
const RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000];

let mainWindow = null;
let tray = null;
let configStore = null;
let logger = null;
let heartbeatTimer = null;
let commandTimer = null;
let workspaceTimer = null;
let remoteInboxTimer = null;
let remoteInbox = null;
let remoteInboxBusy = false;
let workspaceBusy = false;
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
  unityRoots: [],
  workspaceSyncEnabled: false,
  autoCaptureUnity: false,
  workspaceStatus: 'idle',
  workspaceMessage: 'Unity workspace sync is not configured.',
  lastWorkspaceSync: '',
  workspaceResults: [],
  githubConfigured: false,
  githubRepo: 'somosanimales239-cmd/Nexa-AI-Local-Bridge',
  githubBranch: 'nexa-unity-workspace',
  githubSyncEnabled: false,
  githubApplyEnabled: false,
  githubStatus: 'idle',
  githubMessage: 'GitHub Remote Workspace is not configured.',
  githubLastSync: '',
  githubLastCommit: '',
  githubPullResults: [],
  remoteInboxEnabled: false,
  remoteInboxConfigured: false,
  remoteInboxHost: 'pop.hostinger.com',
  remoteInboxPort: 995,
  remoteInboxUsername: '',
  remoteInboxAllowedSender: '',
  remoteInboxPollSeconds: 15,
  remoteInboxRequireAuth: true,
  remoteInboxStatus: 'idle',
  remoteInboxMessage: 'Remote Command Inbox is not configured.',
  remoteInboxLastCheck: '',
  remoteInboxLastCommand: '',
  remoteChannelId: '',
  remoteChallengeExpiresAt: '',
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
  state.unityRoots = Array.isArray(cfg.unityRoots) ? cfg.unityRoots : [];
  state.workspaceSyncEnabled = cfg.workspaceSyncEnabled === true;
  state.autoCaptureUnity = cfg.autoCaptureUnity === true;
  state.githubConfigured = cfg.githubConfigured === true;
  state.githubRepo = cfg.githubRepo || 'somosanimales239-cmd/Nexa-AI-Local-Bridge';
  state.githubBranch = cfg.githubBranch || 'nexa-unity-workspace';
  state.githubSyncEnabled = cfg.githubSyncEnabled === true;
  state.githubApplyEnabled = cfg.githubApplyEnabled === true;
  state.remoteInboxEnabled = cfg.remoteInboxEnabled === true;
  state.remoteInboxConfigured = cfg.remoteInboxConfigured === true;
  state.remoteInboxHost = cfg.remoteInboxHost || 'pop.hostinger.com';
  state.remoteInboxPort = cfg.remoteInboxPort || 995;
  state.remoteInboxUsername = cfg.remoteInboxUsername || '';
  state.remoteInboxAllowedSender = cfg.remoteInboxAllowedSender || '';
  state.remoteInboxPollSeconds = cfg.remoteInboxPollSeconds || 15;
  state.remoteInboxRequireAuth = cfg.remoteInboxRequireAuth !== false;
  if (remoteInbox) {
    const rs = remoteInbox.getPublicStatus({ enabled:state.remoteInboxEnabled, configured:state.remoteInboxConfigured, pollSeconds:state.remoteInboxPollSeconds, policy:policy.snapshot() });
    state.remoteInboxStatus = rs.state || 'idle';
    state.remoteInboxLastCheck = rs.last_check_at || '';
    state.remoteInboxLastCommand = rs.last_command_id || '';
    state.remoteChannelId = rs.channel_id || '';
    state.remoteChallengeExpiresAt = rs.challenge_expires_at || '';
    state.remoteInboxMessage = state.remoteInboxEnabled
      ? (state.remoteInboxConfigured ? 'Secure email command channel is enabled.' : 'Remote Command Inbox is enabled but mailbox credentials are incomplete.')
      : 'Remote Command Inbox is disabled.';
  }
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

function stopWorkspaceTimer() {
  if (workspaceTimer) clearTimeout(workspaceTimer);
  workspaceTimer = null;
}

function stopRemoteInboxTimer() {
  if (remoteInboxTimer) clearTimeout(remoteInboxTimer);
  remoteInboxTimer = null;
}

function remoteExecutionContext() {
  const cfg = configStore.publicConfig();
  return {
    policy,
    systemInfo,
    allowedRoots: cfg.allowedRoots || [],
    unityRoots: cfg.unityRoots || [],
    userDataPath: app.getPath('userData'),
  };
}

function refreshRemoteInboxState(message) {
  if (!remoteInbox || !configStore) return;
  const cfg = configStore.publicConfig();
  const rs = remoteInbox.getPublicStatus({ enabled:cfg.remoteInboxEnabled, configured:cfg.remoteInboxConfigured, pollSeconds:cfg.remoteInboxPollSeconds, policy:policy.snapshot() });
  state.remoteInboxStatus = rs.state || 'idle';
  state.remoteInboxLastCheck = rs.last_check_at || '';
  state.remoteInboxLastCommand = rs.last_command_id || '';
  state.remoteChannelId = rs.channel_id || '';
  state.remoteChallengeExpiresAt = rs.challenge_expires_at || '';
  state.remoteInboxMessage = message || (cfg.remoteInboxEnabled ? (cfg.remoteInboxConfigured ? 'Secure email command channel is enabled.' : 'Remote Command Inbox credentials are incomplete.') : 'Remote Command Inbox is disabled.');
  try { remoteInbox.writeProjectStatus(cfg.unityRoots || [], rs); } catch {}
  broadcastState();
}

function scheduleRemoteInbox(delayMs) {
  stopRemoteInboxTimer();
  const cfg = configStore?.publicConfig?.() || {};
  if (!state.paired || !state.connected || cfg.remoteInboxEnabled !== true || cfg.remoteInboxConfigured !== true) return;
  const delay = delayMs === undefined ? Math.max(10,Math.min(Number(cfg.remoteInboxPollSeconds || 15),300))*1000 : delayMs;
  remoteInboxTimer = setTimeout(() => {
    remoteInboxCycle(false).catch(error => {
      state.remoteInboxStatus='error';
      state.remoteInboxMessage=error.message;
      safeActivity('warning','remote-inbox',`Remote Command Inbox: ${error.message}`);
      scheduleRemoteInbox(Math.max(15000,delay));
    });
  }, delay);
}

async function remoteInboxCycle(manual=false) {
  stopRemoteInboxTimer();
  if (remoteInboxBusy) return {ok:false,error:'Remote Command Inbox is already checking.'};
  const cfg=configStore.publicConfig();
  if (!cfg.remoteInboxEnabled && !manual) return {ok:true,processed:0,reason:'disabled'};
  if (!cfg.remoteInboxConfigured) throw new Error('Configure the dedicated command mailbox first.');
  remoteInboxBusy=true;
  state.remoteInboxStatus='checking';
  state.remoteInboxMessage='Checking the secure command mailbox…';
  broadcastState();
  try {
    const result=await remoteInbox.poll({
      config:{...cfg,remoteInboxEnabled:true},
      password:configStore.getRemoteInboxPassword(),
      policy:policy.snapshot(),
      unityRoots:cfg.unityRoots || [],
      executeEnvelope:async envelope=>{
        state.currentCommand={uuid:envelope.command_id,action:envelope.actions.map(a=>a.action).join(' + '),status:'running'};
        broadcastState();
        safeActivity('info','remote-command',`Executing ${envelope.actions.length} remote action${envelope.actions.length===1?'':'s'} (${envelope.command_id}).`);
        const execution=await executeRemoteEnvelope(envelope,remoteExecutionContext());
        state.currentCommand=null;
        safeActivity(execution.ok===false?'warning':'info','remote-command',execution.ok===false?`Remote command failed/rolled back: ${envelope.command_id}.`:`Remote command completed: ${envelope.command_id}.`);
        setTimeout(()=>workspaceSyncCycle(true).catch(error=>safeActivity('warning','remote-command-sync',error.message)),1200);
        return execution;
      },
    });
    refreshRemoteInboxState(result.processed?`Processed ${result.processed} remote command${result.processed===1?'':'s'}; result publication queued.`:'Command mailbox checked; no new valid commands.');
    return result;
  } finally {
    remoteInboxBusy=false;
    state.currentCommand=null;
    if(configStore.publicConfig().remoteInboxEnabled) scheduleRemoteInbox();
  }
}

function scheduleWorkspaceSync(delayMs = WORKSPACE_SYNC_MS) {
  stopWorkspaceTimer();
  if (!state.paired || !state.connected || !state.workspaceSyncEnabled) return;
  workspaceTimer = setTimeout(() => {
    workspaceSyncCycle(false).catch(error => {
      state.workspaceStatus = 'error';
      state.workspaceMessage = error.message;
      safeActivity('warning', 'unity-workspace', `Workspace sync failed: ${error.message}`);
      scheduleWorkspaceSync(WORKSPACE_SYNC_MS);
    });
  }, delayMs);
}

async function workspaceSyncCycle(manual = false) {
  stopWorkspaceTimer();
  if (workspaceBusy) return { ok: false, error: 'Workspace sync is already running.' };
  if (!state.paired || !state.connected) throw new Error('Connect the Bridge before syncing Unity workspaces.');
  if (!policy.canExecute('read_files')) throw new Error('Enable Read Files in the Hostinger dashboard before workspace sync.');
  const cfg = configStore.publicConfig();
  const roots = Array.isArray(cfg.unityRoots) ? cfg.unityRoots.filter(Boolean) : [];
  if (!roots.length) throw new Error('Add at least one Unity Project Path in the Windows app.');
  const token = configStore.getToken();
  const endpoint = deriveWorkspaceEndpoint(cfg.endpoint);
  workspaceBusy = true;
  state.workspaceStatus = 'syncing';
  state.workspaceMessage = `Syncing ${roots.length} Unity project${roots.length === 1 ? '' : 's'}…`;
  state.workspaceResults = [];
  if (cfg.githubSyncEnabled) {
    state.githubStatus = 'syncing';
    state.githubMessage = 'Publishing GitHub Remote Workspace…';
  }
  broadcastState();
  const results = [];
  const failedResults = [];
  const successfulRoots = [];
  let githubResult = null;
  let githubError = null;
  try {
    for (const root of roots) {
      try {
        if (cfg.autoCaptureUnity === true && policy.canExecute('screenshots')) {
          try { await requestUnityCapture(root, cfg.allowedRoots); await new Promise(r => setTimeout(r, 1800)); } catch {}
        }
        const result = await syncUnityProject({
          root,
          allowedRoots: cfg.allowedRoots,
          endpoint,
          token,
          screenshotPermission: policy.canExecute('screenshots'),
        });
        results.push(result);
        successfulRoots.push(root);
        safeActivity('info', 'unity-workspace', `Synced ${result.name}: ${result.file_count} mirrored files.`);
      } catch (error) {
        const failed = {
          name: path.basename(String(root || '')) || String(root || 'Unity project'),
          root: String(root || ''),
          error: error.message,
        };
        failedResults.push(failed);
        safeActivity('warning', 'unity-workspace', `Skipped ${failed.name}: ${error.message}`);
      }
    }

    if (!results.length) {
      state.workspaceStatus = 'error';
      state.workspaceMessage = `No Unity project could be synchronized. ${failedResults.map(r => `${r.name}: ${r.error}`).join(' | ')}`;
      state.workspaceResults = failedResults.map(r => ({ name:r.name, fileCount:0, compileErrors:0, serviceIssues:0, serviceIssueOccurrences:0, artifacts:[], error:r.error }));
      broadcastState();
      throw new Error(state.workspaceMessage);
    }

    state.workspaceStatus = 'synced';
    state.workspaceMessage = failedResults.length
      ? `Unity workspace synced: ${results.map(r => r.name).join(', ')}. Skipped ${failedResults.length} invalid/unavailable path${failedResults.length === 1 ? '' : 's'}.`
      : `Unity workspace synced: ${results.map(r => r.name).join(', ')}.`;
    state.lastWorkspaceSync = new Date().toISOString();
    state.workspaceResults = [
      ...results.map(r => ({
        name:r.name,
        fileCount:r.file_count,
        compileErrors:r.stats?.compile_error_count || 0,
        compileErrorOccurrences:r.stats?.compile_error_occurrences || 0,
        serviceIssues:r.stats?.service_issue_count || 0,
        serviceIssueOccurrences:r.stats?.service_issue_occurrences || 0,
        licensingIssues:r.stats?.licensing_issue_count || 0,
        licensingIssueOccurrences:r.stats?.licensing_issue_occurrences || 0,
        health:r.status?.project_health || 'healthy',
        pluginVersion:r.status?.plugin_version || '',
        pluginUpdateRequired:r.status?.plugin_update_required === true,
        artifacts:r.artifacts || [],
      })),
      ...failedResults.map(r => ({
        name:r.name,
        fileCount:0,
        compileErrors:0,
        serviceIssues:0,
        serviceIssueOccurrences:0,
        artifacts:[],
        error:r.error,
      })),
    ];

    if (cfg.githubSyncEnabled) {
      try {
        if (!cfg.githubConfigured) throw new Error('Save a GitHub token before enabling GitHub Remote Workspace.');
        githubResult = await publishGithubWorkspaces({
          roots: successfulRoots,
          allowedRoots: cfg.allowedRoots,
          repo: cfg.githubRepo,
          branch: cfg.githubBranch,
          token: configStore.getGithubToken(),
          stateFile: path.join(app.getPath('userData'), 'github-workspace-state.json'),
          applyRemote: cfg.githubApplyEnabled === true,
          writePermission: policy.canExecute('write_files'),
          screenshotPermission: policy.canExecute('screenshots'),
        });
        state.githubStatus = 'synced';
        state.githubMessage = `GitHub workspace published to ${githubResult.repo} · ${githubResult.branch}.`;
        state.githubLastSync = new Date().toISOString();
        state.githubLastCommit = githubResult.commitSha || '';
        state.githubPullResults = githubResult.pullResults || [];
        const applied = state.githubPullResults.reduce((n,r)=>n+(r.applied||0),0);
        const conflicts = state.githubPullResults.reduce((n,r)=>n+(r.conflicts||0),0);
        safeActivity('info', 'github-workspace', `Published GitHub workspace${applied ? ` and applied ${applied} remote edit${applied===1?'':'s'}` : ''}${conflicts ? `; ${conflicts} conflict${conflicts===1?'':'s'} protected` : ''}.`);
      } catch (error) {
        githubError = error;
        state.githubStatus = 'error';
        state.githubMessage = error.message;
        safeActivity('warning', 'github-workspace', `GitHub workspace sync failed: ${error.message}`);
      }
    } else {
      state.githubStatus = cfg.githubConfigured ? 'idle' : 'idle';
      state.githubMessage = cfg.githubConfigured ? 'GitHub Remote Workspace is configured but automatic publishing is OFF.' : 'GitHub Remote Workspace is not configured.';
    }
    broadcastState();
    return { ok: true, results, github: githubResult, githubError: githubError?.message || '', state: publicState() };
  } finally {
    workspaceBusy = false;
    if (state.workspaceSyncEnabled) scheduleWorkspaceSync(WORKSPACE_SYNC_MS);
  }
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
  if (state.workspaceSyncEnabled && !workspaceTimer && !workspaceBusy) scheduleWorkspaceSync(2500);
  if (configStore.publicConfig().remoteInboxEnabled && !remoteInboxTimer && !remoteInboxBusy) scheduleRemoteInbox(1800);
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
      unityRoots: Array.isArray(payload?.unityRoots) ? payload.unityRoots : current.unityRoots,
      workspaceSyncEnabled: payload?.workspaceSyncEnabled === undefined ? current.workspaceSyncEnabled : payload.workspaceSyncEnabled === true,
      autoCaptureUnity: payload?.autoCaptureUnity === undefined ? current.autoCaptureUnity : payload.autoCaptureUnity === true,
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
  if (!policy.authenticated || !policy.bridgeEnabled || policy.emergencyStop) {
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
      const result = await executeSingleRemoteCommand(command, remoteExecutionContext());
      if (result && result.cancelled) {
        await submitCommandCancelled(endpoint, token, command.uuid);
      } else if (result && result.ok === false) {
        await submitCommandError(endpoint, token, command.uuid, result.error || 'Remote command failed.');
      } else {
        await submitCommandResult(endpoint, token, command.uuid, result);
      }
      safeActivity(result?.ok===false?'warning':'info', 'command', `${result?.ok===false?'Command failed':'Command completed'}: ${command.action} (${command.uuid}).`);
      if (result?.changed_files?.length) setTimeout(()=>workspaceSyncCycle(true).catch(()=>{}),1200);
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
  stopWorkspaceTimer();
  stopRemoteInboxTimer();
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
    { label: 'Quit', click: () => { quitting = true; stopTimer(); stopCommandTimer(); stopWorkspaceTimer(); stopRemoteInboxTimer(); app.quit(); } },
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
    unityRoots: Array.isArray(payload?.unityRoots) ? payload.unityRoots : undefined,
    workspaceSyncEnabled: payload?.workspaceSyncEnabled,
    autoCaptureUnity: payload?.autoCaptureUnity,
    githubSyncEnabled: payload?.githubSyncEnabled,
    githubApplyEnabled: payload?.githubApplyEnabled,
    remoteInboxEnabled: payload?.remoteInboxEnabled,
  });
  updateConfigState();
  applyLoginPreference(next.startWithWindows);
  safeActivity('info', 'preferences', 'Local preferences updated.');
  if (next.remoteInboxEnabled && next.remoteInboxConfigured && state.connected) scheduleRemoteInbox(500); else stopRemoteInboxTimer();
  refreshRemoteInboxState();
  return { ok: true, state: publicState() };
});

ipcMain.handle('bridge:remote-inbox-save', async (_event, payload) => {
  try {
    const current=configStore.publicConfig();
    const password=typeof payload?.password==='string' && payload.password ? payload.password : configStore.getRemoteInboxPassword();
    if(!password) throw new Error('Enter the dedicated command mailbox password.');
    const candidate={
      host:String(payload?.host || current.remoteInboxHost || 'pop.hostinger.com').trim(),
      port:Number(payload?.port || current.remoteInboxPort || 995),
      username:String(payload?.username || current.remoteInboxUsername || '').trim(),
      password,
    };
    const test=await testPop3Mailbox(candidate);
    const next=configStore.saveRemoteInbox({
      enabled:payload?.enabled===true,
      host:candidate.host,
      port:candidate.port,
      username:candidate.username,
      password:typeof payload?.password==='string'?payload.password:'',
      allowedSender:String(payload?.allowedSender || current.remoteInboxAllowedSender || '').trim(),
      pollSeconds:Number(payload?.pollSeconds || current.remoteInboxPollSeconds || 15),
      requireAuth:payload?.requireAuth!==false,
    });
    updateConfigState();
    refreshRemoteInboxState(`Command mailbox verified (${test.message_count ?? 'unknown'} messages) and saved securely.`);
    if(next.remoteInboxEnabled && state.connected) scheduleRemoteInbox(500);
    safeActivity('info','remote-inbox','Secure Remote Command Inbox verified and saved.');
    return {ok:true,test,state:publicState()};
  } catch(error){
    state.remoteInboxStatus='error'; state.remoteInboxMessage=error.message; broadcastState();
    safeActivity('warning','remote-inbox',`Remote Command Inbox setup failed: ${error.message}`);
    return {ok:false,error:error.message};
  }
});

ipcMain.handle('bridge:remote-inbox-test', async (_event,payload)=>{
  try{
    const current=configStore.publicConfig();
    const password=typeof payload?.password==='string' && payload.password ? payload.password : configStore.getRemoteInboxPassword();
    const result=await testPop3Mailbox({
      host:String(payload?.host || current.remoteInboxHost || 'pop.hostinger.com').trim(),
      port:Number(payload?.port || current.remoteInboxPort || 995),
      username:String(payload?.username || current.remoteInboxUsername || '').trim(),
      password,
    });
    safeActivity('info','remote-inbox','Remote Command Inbox POP3S test passed.');
    return {ok:true,...result};
  }catch(error){safeActivity('warning','remote-inbox',error.message);return{ok:false,error:error.message};}
});

ipcMain.handle('bridge:remote-inbox-check-now', async()=>{
  try{return await remoteInboxCycle(true);}catch(error){state.remoteInboxStatus='error';state.remoteInboxMessage=error.message;broadcastState();return{ok:false,error:error.message};}
});

ipcMain.handle('bridge:remote-inbox-clear', ()=>{
  stopRemoteInboxTimer();
  configStore.clearRemoteInbox();
  updateConfigState();
  refreshRemoteInboxState('Remote Command Inbox credentials removed from this PC.');
  safeActivity('warning','remote-inbox','Remote Command Inbox credentials were cleared.');
  return {ok:true,state:publicState()};
});

ipcMain.handle('bridge:github-save', async (_event, payload) => {
  try {
    const repo = validateRepo(payload?.repo);
    const branch = validateBranch(payload?.branch || 'nexa-unity-workspace');
    const token = typeof payload?.token === 'string' && payload.token.trim() ? payload.token.trim() : configStore.getGithubToken();
    if (!token) throw new Error('Enter a GitHub fine-grained token.');
    await testGithubConnection({ repo, token });
    configStore.saveGithub({
      repo,
      branch,
      token: typeof payload?.token === 'string' ? payload.token : '',
      syncEnabled: payload?.syncEnabled === true,
      applyEnabled: payload?.applyEnabled === true,
    });
    updateConfigState();
    state.githubStatus = 'ready';
    state.githubMessage = `GitHub access verified for ${repo}.`;
    safeActivity('info', 'github-workspace', `GitHub Remote Workspace configured for ${repo} on branch ${branch}.`);
    broadcastState();
    return { ok:true, state:publicState() };
  } catch (error) {
    state.githubStatus = 'error'; state.githubMessage = error.message; broadcastState();
    safeActivity('warning', 'github-workspace', `GitHub setup failed: ${error.message}`);
    return { ok:false, error:error.message, code:error.code||'ERROR' };
  }
});

ipcMain.handle('bridge:github-test', async (_event, payload) => {
  try {
    const cfg = configStore.publicConfig();
    const repo = validateRepo(payload?.repo || cfg.githubRepo);
    const token = typeof payload?.token === 'string' && payload.token.trim() ? payload.token.trim() : configStore.getGithubToken();
    if (!token) throw new Error('Enter a GitHub fine-grained token.');
    const result = await testGithubConnection({ repo, token });
    safeActivity('info', 'github-workspace', `GitHub connection test passed for ${repo}.`);
    return { ok:true, ...result };
  } catch (error) {
    safeActivity('warning', 'github-workspace', `GitHub connection test failed: ${error.message}`);
    return { ok:false, error:error.message, code:error.code||'ERROR' };
  }
});

ipcMain.handle('bridge:github-sync-now', async () => {
  try {
    const cfg = configStore.publicConfig();
    if (!cfg.githubConfigured) throw new Error('Configure GitHub Remote Workspace first.');
    if (!policy.canExecute('read_files')) throw new Error('Enable Read Files in Hostinger before GitHub publishing.');
    const roots = Array.isArray(cfg.unityRoots) ? cfg.unityRoots.filter(Boolean) : [];
    if (!roots.length) throw new Error('Add at least one Unity Project Path.');
    state.githubStatus='syncing'; state.githubMessage='Publishing GitHub Remote Workspace…'; broadcastState();
    const result = await publishGithubWorkspaces({
      roots,
      allowedRoots: cfg.allowedRoots,
      repo: cfg.githubRepo,
      branch: cfg.githubBranch,
      token: configStore.getGithubToken(),
      stateFile: path.join(app.getPath('userData'), 'github-workspace-state.json'),
      applyRemote: cfg.githubApplyEnabled === true,
      writePermission: policy.canExecute('write_files'),
      screenshotPermission: policy.canExecute('screenshots'),
    });
    state.githubStatus='synced'; state.githubMessage=`GitHub workspace published to ${result.repo} · ${result.branch}.`; state.githubLastSync=new Date().toISOString(); state.githubLastCommit=result.commitSha||''; state.githubPullResults=result.pullResults||[];
    safeActivity('info','github-workspace',`GitHub workspace published: ${result.commitSha||'commit created'}.`); broadcastState();
    return {ok:true,result,state:publicState()};
  } catch(error){ state.githubStatus='error';state.githubMessage=error.message;broadcastState();safeActivity('warning','github-workspace',error.message);return{ok:false,error:error.message,code:error.code||'ERROR'}; }
});

ipcMain.handle('bridge:workspace-sync-now', async () => {
  try { return await workspaceSyncCycle(true); }
  catch (error) {
    state.workspaceStatus = 'error'; state.workspaceMessage = error.message; broadcastState();
    safeActivity('warning', 'unity-workspace', error.message);
    return { ok:false, error:error.message };
  }
});

ipcMain.handle('bridge:unity-install', async (_event, root) => {
  try {
    const result = await installUnityIntegration(root, configStore.publicConfig().allowedRoots);
    safeActivity('info', 'unity', `Unity integration installed: ${result.file}`);
    return { ok:true, ...result };
  } catch (error) { return { ok:false, error:error.message }; }
});

ipcMain.handle('bridge:unity-capture', async (_event, root) => {
  try {
    await requestUnityCapture(root, configStore.publicConfig().allowedRoots);
    safeActivity('info', 'unity', 'Requested Scene View and Game View capture from Unity Editor.');
    return { ok:true };
  } catch (error) { return { ok:false, error:error.message }; }
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
  state.unityRoots = [];
  state.workspaceSyncEnabled = false;
  state.workspaceStatus = 'idle';
  state.workspaceMessage = 'Unity workspace sync is not configured.';
  state.githubConfigured = false;
  state.githubSyncEnabled = false;
  state.githubApplyEnabled = false;
  state.githubStatus = 'idle';
  state.githubMessage = 'GitHub Remote Workspace is not configured.';
  state.githubLastSync = '';
  state.githubLastCommit = '';
  state.githubPullResults = [];
  state.remoteInboxEnabled = false;
  state.remoteInboxConfigured = false;
  state.remoteInboxStatus = 'idle';
  state.remoteInboxMessage = 'Remote Command Inbox is not configured.';
  state.remoteInboxLastCheck = '';
  state.remoteInboxLastCommand = '';
  state.remoteChannelId = '';
  state.remoteChallengeExpiresAt = '';
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
  remoteInbox = new RemoteCommandInbox({ userDataPath: app.getPath('userData'), logger });
  updateConfigState();
  refreshRemoteInboxState();

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
  stopWorkspaceTimer();
  stopRemoteInboxTimer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'win32') app.quit();
});
