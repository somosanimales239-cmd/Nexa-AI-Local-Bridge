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
  els.version.textContent = `v${text(state.version || '1.2.2')}`;
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
  }

  els.autoConnect.checked = state.autoConnect === true;
  els.startWithWindows.checked = state.startWithWindows === true;
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
}

function payload() {
  return {
    endpoint: els.endpoint.value.trim(),
    token: els.token.value.trim(),
    deviceLabel: els.deviceLabel.value.trim() || 'Main Windows PC',
    autoConnect: els.autoConnect.checked,
    startWithWindows: els.startWithWindows.checked,
    allowedRoots: els.allowedRoots.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean),
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
  });
}
els.autoConnect.addEventListener('change', savePreferences);
els.startWithWindows.addEventListener('change', savePreferences);
els.saveLocalBtn.addEventListener('click', async () => {
  await savePreferences();
  formTouched = false;
  showTest('Local Allowed Folders and preferences saved.', true);
});
els.openLogsBtn.addEventListener('click', () => window.nexaBridge.openLogs());

window.nexaBridge.onState(render);
window.nexaBridge.getState().then(render);
