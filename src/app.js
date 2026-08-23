'use strict';

const PERMISSIONS = [
  ['read_files','Read Files'],['write_files','Write Files'],['cmd','CMD'],
  ['powershell','PowerShell'],['python','Python'],['git','Git'],
  ['browser','Browser'],['screenshots','Screenshots'],['blender','Blender'],
  ['local_servers','Local Servers']
];

const $ = selector => document.querySelector(selector);
const els = {
  version: $('#version'), statusPill: $('#statusPill'), statusText: $('#statusText'),
  statusMessage: $('#statusMessage'), emergency: $('#emergencyBanner'),
  endpoint: $('#endpoint'), token: $('#token'), tokenHint: $('#tokenHint'),
  deviceLabel: $('#deviceLabel'), testBtn: $('#testBtn'), connectBtn: $('#connectBtn'),
  reconnectBtn: $('#reconnectBtn'), disconnectBtn: $('#disconnectBtn'), unpairBtn: $('#unpairBtn'),
  testResult: $('#testResult'), permissionGrid: $('#permissionGrid'), bridgeChip: $('#bridgeChip'),
  fullModeChip: $('#fullModeChip'), pcName: $('#pcName'), osName: $('#osName'),
  gpu: $('#gpu'), localIp: $('#localIp'), lastHeartbeat: $('#lastHeartbeat'),
  serverTime: $('#serverTime'), autoConnect: $('#autoConnect'),
  startWithWindows: $('#startWithWindows'), activity: $('#activity'),
  openLogsBtn: $('#openLogsBtn'), allowedRoots: $('#allowedRoots'), saveLocalBtn: $('#saveLocalBtn'),
  queueBadge: $('#queueBadge'), currentCommand: $('#currentCommand'),
  unityRoots: $('#unityRoots'), workspaceSyncEnabled: $('#workspaceSyncEnabled'), autoCaptureUnity: $('#autoCaptureUnity'),
  syncWorkspaceBtn: $('#syncWorkspaceBtn'), installUnityBtn: $('#installUnityBtn'), captureUnityBtn: $('#captureUnityBtn'),
  workspaceBadge: $('#workspaceBadge'), workspaceMessage: $('#workspaceMessage'), workspaceResults: $('#workspaceResults'),
  githubBadge: $('#githubBadge'), githubRepo: $('#githubRepo'), githubBranch: $('#githubBranch'), githubToken: $('#githubToken'), githubTokenHint: $('#githubTokenHint'),
  githubSyncEnabled: $('#githubSyncEnabled'), githubApplyEnabled: $('#githubApplyEnabled'), githubSaveBtn: $('#githubSaveBtn'), githubTestBtn: $('#githubTestBtn'), githubSyncBtn: $('#githubSyncBtn'), githubMessage: $('#githubMessage'), githubResults: $('#githubResults'),
  remoteInboxBadge: $('#remoteInboxBadge'), remoteInboxHost: $('#remoteInboxHost'), remoteInboxPort: $('#remoteInboxPort'), remoteInboxUsername: $('#remoteInboxUsername'), remoteInboxPassword: $('#remoteInboxPassword'), remoteInboxPasswordHint: $('#remoteInboxPasswordHint'), remoteInboxAllowedSender: $('#remoteInboxAllowedSender'), remoteInboxPollSeconds: $('#remoteInboxPollSeconds'), remoteInboxSmtpHost: $('#remoteInboxSmtpHost'), remoteInboxSmtpPort: $('#remoteInboxSmtpPort'), remoteInboxResultRecipient: $('#remoteInboxResultRecipient'), remoteInboxSendResults: $('#remoteInboxSendResults'), remoteInboxEnabled: $('#remoteInboxEnabled'), remoteInboxRequireAuth: $('#remoteInboxRequireAuth'), remoteInboxSaveBtn: $('#remoteInboxSaveBtn'), remoteInboxTestBtn: $('#remoteInboxTestBtn'), remoteInboxCheckBtn: $('#remoteInboxCheckBtn'), remoteInboxClearBtn: $('#remoteInboxClearBtn'), remoteInboxMessage: $('#remoteInboxMessage'), remoteInboxResults: $('#remoteInboxResults'),
};

let latestState = null;
let formTouched = false;

function text(value) {
  return String(value ?? '').replace(/[<>]/g, '');
}

function formatTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString();
}

function permissionCards(permissions = {}) {
  els.permissionGrid.innerHTML = PERMISSIONS.map(([key,label]) => {
    const allowed = permissions[key] === true;
    return `<div class="permission ${allowed ? 'allowed' : 'blocked'}">
      <span class="permission-icon">${allowed ? '✓' : '×'}</span>
      <div><strong>${label}</strong><small>${allowed ? 'Allowed' : 'Blocked'}</small></div>
    </div>`;
  }).join('');
}

function renderActivity(rows = []) {
  if (!rows.length) {
    els.activity.innerHTML = '<div class="empty">No activity yet.</div>';
    return;
  }
  els.activity.innerHTML = rows.slice(0, 12).map(row => `
    <div class="activity-row">
      <span class="activity-level ${text(row.level)}"></span>
      <div><strong>${text(row.event || 'app')}</strong><p>${text(row.message || '')}</p></div>
      <time>${formatTime(row.timestamp)}</time>
    </div>`).join('');
}

function statusClass(status) {
  if (status === 'connected') return 'online';
  if (status === 'connecting' || status === 'reconnecting') return 'warning';
  if (status === 'cloud-disabled' || status === 'auth-failed') return 'danger';
  return 'offline';
}

function render(state) {
  if (!state) return;
  latestState = state;
  els.version.textContent = `v${text(state.version || '1.6.2')}`;
  els.statusText.textContent = text((state.status || 'offline').replaceAll('-', ' ').toUpperCase());
  els.statusPill.className = `status-pill ${statusClass(state.status)}`;
  els.statusMessage.textContent = text(state.statusMessage || '');

  const policy = state.policy || {};
  els.emergency.classList.toggle('hidden', policy.emergencyStop !== true);
  els.bridgeChip.textContent = policy.bridgeEnabled ? 'Bridge Enabled' : 'Bridge Disabled';
  els.bridgeChip.className = `chip ${policy.bridgeEnabled ? 'allowed' : 'blocked'}`;
  els.fullModeChip.textContent = policy.fullComputerMode ? 'Full Computer Mode' : 'Controlled Mode';
  els.fullModeChip.className = `chip ${policy.fullComputerMode ? 'warning' : 'blocked'}`;

  permissionCards(policy.permissions || {});
  renderActivity(state.activity || []);

  els.pcName.textContent = text(state.pcName || 'Windows PC');
  els.osName.textContent = text(state.osName || 'Windows');
  els.gpu.textContent = text(state.gpu || 'Unavailable');
  els.localIp.textContent = text(state.localIp || '—');
  els.lastHeartbeat.textContent = formatTime(state.lastHeartbeat);
  els.serverTime.textContent = text(state.serverTime || '—');

  if (!formTouched) {
    els.endpoint.value = state.endpoint || '';
    els.deviceLabel.value = state.deviceLabel || 'Main Windows PC';
    els.allowedRoots.value = Array.isArray(state.allowedRoots) ? state.allowedRoots.join('\n') : '';
    els.unityRoots.value = Array.isArray(state.unityRoots) ? state.unityRoots.join('\n') : '';
    els.githubRepo.value = state.githubRepo || 'somosanimales239-cmd/Nexa-AI-Local-Bridge';
    els.githubBranch.value = state.githubBranch || 'nexa-unity-workspace';
    els.remoteInboxHost.value = state.remoteInboxHost || 'pop.hostinger.com';
    els.remoteInboxPort.value = state.remoteInboxPort || 995;
    els.remoteInboxUsername.value = state.remoteInboxUsername || '';
    els.remoteInboxAllowedSender.value = state.remoteInboxAllowedSender || '';
    els.remoteInboxPollSeconds.value = state.remoteInboxPollSeconds || 15;
    els.remoteInboxSmtpHost.value = state.remoteInboxSmtpHost || 'smtp.hostinger.com';
    els.remoteInboxSmtpPort.value = state.remoteInboxSmtpPort || 465;
    els.remoteInboxResultRecipient.value = state.remoteInboxResultRecipient || state.remoteInboxAllowedSender || '';
  }

  els.autoConnect.checked = state.autoConnect === true;
  els.startWithWindows.checked = state.startWithWindows === true;
  els.workspaceSyncEnabled.checked = state.workspaceSyncEnabled === true;
  els.autoCaptureUnity.checked = state.autoCaptureUnity === true;
  els.githubSyncEnabled.checked = state.githubSyncEnabled === true;
  els.githubApplyEnabled.checked = state.githubApplyEnabled === true;
  els.remoteInboxEnabled.checked = state.remoteInboxEnabled === true;
  els.remoteInboxRequireAuth.checked = state.remoteInboxRequireAuth !== false;
  els.remoteInboxSendResults.checked = state.remoteInboxSendResults !== false;
  els.remoteInboxPassword.placeholder = state.remoteInboxConfigured ? 'Stored securely — leave blank to reuse' : 'Dedicated mailbox password';
  els.remoteInboxPasswordHint.textContent = state.remoteInboxConfigured
    ? 'Mailbox password is encrypted with Electron safeStorage. Leave blank to reuse it.'
    : 'Encrypted on this PC with Electron safeStorage. Never published to GitHub or Hostinger workspace.';
  els.githubToken.placeholder = state.githubConfigured ? 'Stored securely — leave blank to reuse' : 'github_pat_...';
  els.githubTokenHint.textContent = state.githubConfigured
    ? 'GitHub token is stored with Electron safeStorage. Leave blank to reuse it. It is never sent to Hostinger.'
    : 'Fine-grained token: Contents · Read and write for this repository. Stored only on this PC.';
  els.token.placeholder = state.paired ? 'Stored securely — leave blank to reuse' : 'nexa_...';
  els.tokenHint.textContent = state.paired
    ? 'A token is stored using Electron safeStorage. Leave this field blank to reuse it.'
    : 'Generated in your Nexa AI Computer Bridge dashboard.';

  els.disconnectBtn.disabled = !state.connected;
  els.reconnectBtn.disabled = !state.paired;
  els.unpairBtn.disabled = !state.paired;

  const current = state.currentCommand;
  els.queueBadge.textContent = current ? 'Running' : 'Idle';
  els.queueBadge.className = `chip ${current ? 'warning' : 'blocked'}`;
  els.currentCommand.className = `current-command ${current ? '' : 'empty'}`;
  els.currentCommand.innerHTML = current
    ? `<strong>${text(current.action)}</strong><code>${text(current.uuid)}</code><span>${text(current.status || 'running')}</span>`
    : 'No remote command is running.';

  const wsStatus = state.workspaceStatus || 'idle';
  els.workspaceBadge.textContent = wsStatus === 'syncing' ? 'Syncing' : wsStatus === 'synced' ? 'Synced' : wsStatus === 'error' ? 'Error' : 'Idle';
  els.workspaceBadge.className = `chip ${wsStatus === 'synced' ? 'allowed' : wsStatus === 'syncing' ? 'warning' : wsStatus === 'error' ? 'danger' : 'blocked'}`;
  els.workspaceMessage.textContent = text(state.workspaceMessage || '');
  const results = Array.isArray(state.workspaceResults) ? state.workspaceResults : [];
  els.workspaceResults.innerHTML = results.map(r => {
    if (r.error) {
      return `<div class="workspace-result"><strong>${text(r.name)}</strong><span>Sync skipped</span><small>${text(r.error)}</small></div>`;
    }
    const compileLabel = `${text(r.compileErrors || 0)} real compile error${Number(r.compileErrors || 0) === 1 ? '' : 's'}`;
    const serviceLabel = `${text(r.serviceIssues || 0)} Unity service issue${Number(r.serviceIssues || 0) === 1 ? '' : 's'}`;
    const repeated = Number(r.serviceIssueOccurrences || 0) > Number(r.serviceIssues || 0)
      ? ` · ${text(r.serviceIssueOccurrences)} service events`
      : '';
    const plugin = r.pluginUpdateRequired
      ? 'Unity integration update required — click Install Unity Integration once'
      : r.pluginVersion
        ? `Unity integration ${text(r.pluginVersion)}`
        : 'Unity integration version not reported';
    const visuals = Array.isArray(r.artifacts) && r.artifacts.length
      ? `Visuals: ${r.artifacts.map(text).join(', ')}`
      : 'No new visuals uploaded';
    return `<div class="workspace-result"><strong>${text(r.name)}</strong><span>${text(r.fileCount)} files · ${compileLabel} · ${serviceLabel}${repeated}</span><small>${plugin} · ${visuals}</small></div>`;
  }).join('');

  const riStatus = state.remoteInboxStatus || 'idle';
  els.remoteInboxBadge.textContent = riStatus === 'checking' ? 'Checking' : riStatus === 'executing' ? 'Executing' : riStatus === 'error' ? 'Error' : state.remoteInboxEnabled ? (state.remoteInboxConfigured ? 'Ready' : 'Setup') : 'Off';
  els.remoteInboxBadge.className = `chip ${riStatus === 'error' ? 'danger' : riStatus === 'checking' || riStatus === 'executing' ? 'warning' : state.remoteInboxEnabled && state.remoteInboxConfigured ? 'allowed' : 'blocked'}`;
  els.remoteInboxMessage.textContent = text(state.remoteInboxMessage || '');
  const channel = state.remoteChannelId ? `Channel ${text(state.remoteChannelId).slice(0,24)}…` : 'Channel not initialized';
  const lastCheck = state.remoteInboxLastCheck ? `Last check: ${formatTime(state.remoteInboxLastCheck)}` : 'Not checked yet';
  const lastCommand = state.remoteInboxLastCommand ? `Last command: ${text(state.remoteInboxLastCommand)}` : 'No remote command processed yet';
  const challenge = state.remoteChallengeExpiresAt ? `Challenge expires: ${formatTime(state.remoteChallengeExpiresAt)}` : 'Challenge not published yet';
  els.remoteInboxResults.innerHTML = `<div class="workspace-result"><strong>${channel}</strong><span>${lastCheck}</span><small>${lastCommand} · ${challenge}</small></div>`;

  const ghStatus = state.githubStatus || 'idle';
  els.githubBadge.textContent = ghStatus === 'syncing' ? 'Publishing' : ghStatus === 'synced' ? 'Synced' : ghStatus === 'ready' ? 'Ready' : ghStatus === 'error' ? 'Error' : 'Idle';
  els.githubBadge.className = `chip ${ghStatus === 'synced' || ghStatus === 'ready' ? 'allowed' : ghStatus === 'syncing' ? 'warning' : ghStatus === 'error' ? 'danger' : 'blocked'}`;
  els.githubMessage.textContent = text(state.githubMessage || '');
  const ghPull = Array.isArray(state.githubPullResults) ? state.githubPullResults : [];
  const commit = state.githubLastCommit ? `Commit ${text(state.githubLastCommit).slice(0,12)}` : 'No GitHub snapshot yet';
  els.githubResults.innerHTML = `<div class="workspace-result"><strong>${text(state.githubRepo || '')}</strong><span>${text(state.githubBranch || '')} · ${commit}</span><small>${state.githubLastSync ? 'Last publish: '+formatTime(state.githubLastSync) : 'Not published yet'}</small></div>` + ghPull.map(r => `<div class="workspace-result"><strong>${text(r.name)}</strong><span>${text(r.applied || 0)} remote edits applied · ${text(r.conflicts || 0)} conflicts protected</span><small>Remote deletes are ignored by design</small></div>`).join('');
}

function payload() {
  return {
    endpoint: els.endpoint.value.trim(),
    token: els.token.value.trim(),
    deviceLabel: els.deviceLabel.value.trim() || 'Main Windows PC',
    autoConnect: els.autoConnect.checked,
    startWithWindows: els.startWithWindows.checked,
    allowedRoots: els.allowedRoots.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean),
    unityRoots: els.unityRoots.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean),
    workspaceSyncEnabled: els.workspaceSyncEnabled.checked,
    autoCaptureUnity: els.autoCaptureUnity.checked,
  };
}

function showTest(message, ok) {
  els.testResult.classList.remove('hidden', 'success', 'failure');
  els.testResult.classList.add(ok ? 'success' : 'failure');
  els.testResult.textContent = message;
}

async function withBusy(button, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try { return await fn(); }
  finally { button.disabled = false; button.textContent = old; }
}

els.endpoint.addEventListener('input', () => { formTouched = true; });
els.deviceLabel.addEventListener('input', () => { formTouched = true; });
els.allowedRoots.addEventListener('input', () => { formTouched = true; });
els.unityRoots.addEventListener('input', () => { formTouched = true; });
els.githubRepo.addEventListener('input', () => { formTouched = true; });
els.githubBranch.addEventListener('input', () => { formTouched = true; });
els.remoteInboxHost.addEventListener('input', () => { formTouched = true; });
els.remoteInboxPort.addEventListener('input', () => { formTouched = true; });
els.remoteInboxUsername.addEventListener('input', () => { formTouched = true; });
els.remoteInboxAllowedSender.addEventListener('input', () => { formTouched = true; });
els.remoteInboxPollSeconds.addEventListener('input', () => { formTouched = true; });
els.remoteInboxSmtpHost.addEventListener('input', () => { formTouched = true; });
els.remoteInboxSmtpPort.addEventListener('input', () => { formTouched = true; });
els.remoteInboxResultRecipient.addEventListener('input', () => { formTouched = true; });

els.testBtn.addEventListener('click', () => withBusy(els.testBtn, async () => {
  const result = await window.nexaBridge.testConnection(payload());
  if (result.ok) {
    showTest('✓ Endpoint reached · Authentication accepted · Heartbeat accepted · Server policy received', true);
  } else {
    showTest(`Connection test failed: ${result.error}`, false);
  }
}));

els.connectBtn.addEventListener('click', () => withBusy(els.connectBtn, async () => {
  const result = await window.nexaBridge.connect(payload());
  if (!result.ok) showTest(`Connection failed: ${result.error}`, false);
  else {
    els.token.value = '';
    formTouched = false;
    showTest('Connected. This PC is now reporting to Hostinger.', true);
  }
}));

els.reconnectBtn.addEventListener('click', () => withBusy(els.reconnectBtn, async () => {
  const result = await window.nexaBridge.reconnect();
  if (!result.ok) showTest(`Reconnect failed: ${result.error}`, false);
}));

els.disconnectBtn.addEventListener('click', () => window.nexaBridge.disconnect());

els.unpairBtn.addEventListener('click', async () => {
  if (!confirm('Unpair this PC and delete the locally stored pairing token?')) return;
  await window.nexaBridge.unpair();
  els.token.value = '';
  formTouched = false;
  showTest('This PC was unpaired and its local token was removed.', true);
});

async function savePreferences() {
  await window.nexaBridge.updatePreferences({
    autoConnect: els.autoConnect.checked,
    startWithWindows: els.startWithWindows.checked,
    allowedRoots: els.allowedRoots.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean),
    unityRoots: els.unityRoots.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean),
    workspaceSyncEnabled: els.workspaceSyncEnabled.checked,
    autoCaptureUnity: els.autoCaptureUnity.checked,
    githubSyncEnabled: els.githubSyncEnabled.checked,
    githubApplyEnabled: els.githubApplyEnabled.checked,
    remoteInboxEnabled: els.remoteInboxEnabled.checked,
  });
}
els.autoConnect.addEventListener('change', savePreferences);
els.startWithWindows.addEventListener('change', savePreferences);
els.workspaceSyncEnabled.addEventListener('change', savePreferences);
els.autoCaptureUnity.addEventListener('change', savePreferences);
els.githubSyncEnabled.addEventListener('change', savePreferences);
els.githubApplyEnabled.addEventListener('change', savePreferences);
els.remoteInboxEnabled.addEventListener('change', savePreferences);
els.saveLocalBtn.addEventListener('click', async () => {
  await savePreferences();
  formTouched = false;
  showTest('Local Allowed Folders and preferences saved.', true);
});
els.openLogsBtn.addEventListener('click', () => window.nexaBridge.openLogs());

function firstUnityRoot() {
  return els.unityRoots.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean)[0] || '';
}
els.syncWorkspaceBtn.addEventListener('click', () => withBusy(els.syncWorkspaceBtn, async () => {
  await savePreferences();
  const result = await window.nexaBridge.syncWorkspaceNow();
  if (!result.ok) return showTest(`Workspace sync failed: ${result.error}`, false);
  const gh = result.github ? ' GitHub Remote Workspace was published too.' : result.githubError ? ` Hostinger sync succeeded, but GitHub failed: ${result.githubError}` : '';
  showTest(`Unity workspace synchronized with Hostinger.${gh}`, !result.githubError);
}));
els.installUnityBtn.addEventListener('click', () => withBusy(els.installUnityBtn, async () => {
  await savePreferences();
  const root = firstUnityRoot();
  if (!root) return showTest('Add a Unity Project Path first.', false);
  const result = await window.nexaBridge.installUnityIntegration(root);
  showTest(result.ok ? 'Unity integration installed. Return to Unity and allow scripts to compile.' : `Unity integration failed: ${result.error}`, !!result.ok);
}));
els.captureUnityBtn.addEventListener('click', () => withBusy(els.captureUnityBtn, async () => {
  await savePreferences();
  const root = firstUnityRoot();
  if (!root) return showTest('Add a Unity Project Path first.', false);
  const result = await window.nexaBridge.captureUnityViews(root);
  showTest(result.ok ? 'Capture request sent. Keep Unity open, then click Sync Now after a few seconds.' : `Capture request failed: ${result.error}`, !!result.ok);
}));


function remoteInboxPayload() {
  return {
    enabled: els.remoteInboxEnabled.checked,
    host: els.remoteInboxHost.value.trim() || 'pop.hostinger.com',
    port: Number(els.remoteInboxPort.value || 995),
    username: els.remoteInboxUsername.value.trim(),
    password: els.remoteInboxPassword.value,
    allowedSender: els.remoteInboxAllowedSender.value.trim(),
    pollSeconds: Number(els.remoteInboxPollSeconds.value || 15),
    requireAuth: els.remoteInboxRequireAuth.checked,
    smtpHost: els.remoteInboxSmtpHost.value.trim() || 'smtp.hostinger.com',
    smtpPort: Number(els.remoteInboxSmtpPort.value || 465),
    sendResults: els.remoteInboxSendResults.checked,
    resultRecipient: els.remoteInboxResultRecipient.value.trim() || els.remoteInboxAllowedSender.value.trim(),
  };
}

els.remoteInboxTestBtn.addEventListener('click', () => withBusy(els.remoteInboxTestBtn, async () => {
  const result = await window.nexaBridge.testRemoteInbox(remoteInboxPayload());
  showTest(result.ok ? `Secure mailbox transport succeeded.${result.message_count === null || result.message_count === undefined ? '' : ` ${result.message_count} message${result.message_count===1?'':'s'} currently in mailbox.`}${result.smtp_skipped ? ' SMTP result delivery is disabled.' : ' SMTP result login also passed.'}` : `Mailbox test failed: ${result.error}`, !!result.ok);
}));

els.remoteInboxSaveBtn.addEventListener('click', () => withBusy(els.remoteInboxSaveBtn, async () => {
  const result = await window.nexaBridge.saveRemoteInbox(remoteInboxPayload());
  if (result.ok) {
    els.remoteInboxPassword.value = '';
    formTouched = false;
    showTest('Remote Command Inbox verified and saved securely. POP3S commands, cryptographic DKIM checks, attachments, and SMTP result delivery are ready.', true);
  } else showTest(`Remote Command Inbox setup failed: ${result.error}`, false);
}));

els.remoteInboxCheckBtn.addEventListener('click', () => withBusy(els.remoteInboxCheckBtn, async () => {
  const result = await window.nexaBridge.checkRemoteInboxNow();
  showTest(result.ok ? `Command mailbox checked.${result.processed ? ` Processed ${result.processed} command${result.processed===1?'':'s'}.` : ' No new valid command was found.'}` : `Remote inbox check failed: ${result.error}`, !!result.ok);
}));

els.remoteInboxClearBtn.addEventListener('click', async () => {
  if (!confirm('Remove the stored Remote Command Inbox password and disable the command channel on this PC?')) return;
  const result = await window.nexaBridge.clearRemoteInbox();
  if (result.ok) {
    els.remoteInboxPassword.value = '';
    formTouched = false;
    showTest('Remote Command Inbox credentials were removed from this PC.', true);
  }
});

function githubPayload() {
  return {
    repo: els.githubRepo.value.trim(),
    branch: els.githubBranch.value.trim() || 'nexa-unity-workspace',
    token: els.githubToken.value.trim(),
    syncEnabled: els.githubSyncEnabled.checked,
    applyEnabled: els.githubApplyEnabled.checked,
  };
}

els.githubTestBtn.addEventListener('click', () => withBusy(els.githubTestBtn, async () => {
  const result = await window.nexaBridge.testGithubWorkspace(githubPayload());
  showTest(result.ok ? `GitHub connected: ${result.repository}.` : `GitHub test failed: ${result.error}`, !!result.ok);
}));

els.githubSaveBtn.addEventListener('click', () => withBusy(els.githubSaveBtn, async () => {
  const result = await window.nexaBridge.saveGithubWorkspace(githubPayload());
  if (result.ok) {
    els.githubToken.value = '';
    formTouched = false;
    showTest('GitHub Remote Workspace verified and saved securely.', true);
  } else showTest(`GitHub setup failed: ${result.error}`, false);
}));

els.githubSyncBtn.addEventListener('click', () => withBusy(els.githubSyncBtn, async () => {
  await savePreferences();
  const result = await window.nexaBridge.syncGithubWorkspaceNow();
  if (!result.ok) return showTest(`GitHub publish failed: ${result.error}`, false);
  const applied = (result.result?.pullResults || []).reduce((n,r)=>n+(r.applied||0),0);
  const conflicts = (result.result?.pullResults || []).reduce((n,r)=>n+(r.conflicts||0),0);
  showTest(`GitHub workspace published.${applied ? ` Applied ${applied} ChatGPT edit${applied===1?'':'s'} to Unity.` : ''}${conflicts ? ` Protected ${conflicts} local conflict${conflicts===1?'':'s'}.` : ''}`, true);
}));

window.nexaBridge.onState(render);
window.nexaBridge.getState().then(render);
