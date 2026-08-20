'use strict';

const { URL } = require('url');

const PERMISSION_KEYS = [
  'read_files','write_files','cmd','powershell','python',
  'git','browser','screenshots','blender','local_servers'
];

function validateEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a valid Agent Endpoint URL.');
  }

  const localDev = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localDev && url.protocol === 'http:')) {
    throw new Error('Production Agent Endpoint must use HTTPS.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Unsupported Agent Endpoint protocol.');
  url.hash = '';
  return url.toString();
}

function validateHeartbeatResponse(data) {
  if (!data || typeof data !== 'object' || data.ok !== true) {
    throw new Error('Hostinger returned an invalid heartbeat response.');
  }
  const booleans = ['bridge_enabled', 'emergency_stop', 'full_computer_mode'];
  for (const key of booleans) {
    if (typeof data[key] !== 'boolean') throw new Error(`Hostinger response is missing ${key}.`);
  }
  if (!data.permissions || typeof data.permissions !== 'object') {
    throw new Error('Hostinger response is missing permissions.');
  }
  const permissions = {};
  for (const key of PERMISSION_KEYS) permissions[key] = data.permissions[key] === true;
  return {
    ok: true,
    bridge_enabled: data.bridge_enabled,
    emergency_stop: data.emergency_stop,
    full_computer_mode: data.full_computer_mode,
    permissions,
    command_endpoint: typeof data.command_endpoint === 'string' ? data.command_endpoint : '',
    server_time: typeof data.server_time === 'string' ? data.server_time : '',
  };
}

async function postJson(endpoint, token, payload, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    });

    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch {}
    }

    if (response.status === 401) {
      const error = new Error('Pairing token was rejected. Generate a new token in the Nexa AI Computer Bridge dashboard.');
      error.code = 'AUTH_REJECTED';
      throw error;
    }
    if (response.status === 503) {
      const error = new Error('The cloud bridge is currently disabled in the Hostinger dashboard.');
      error.code = 'BRIDGE_DISABLED';
      throw error;
    }
    if (!response.ok) {
      const detail = data && typeof data.error === 'string' ? ` ${data.error}` : '';
      const error = new Error(`Hostinger returned HTTP ${response.status}.${detail}`.trim());
      error.code = response.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
      throw error;
    }
    if (!data) throw new Error('Hostinger returned malformed JSON.');
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error('Connection timed out while contacting Hostinger.');
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sendHeartbeat(endpoint, token, systemInfo) {
  const cleanEndpoint = validateEndpoint(endpoint);
  const raw = await postJson(cleanEndpoint, token, { action: 'heartbeat', ...systemInfo });
  return validateHeartbeatResponse(raw);
}

async function sendServerLog(endpoint, token, level, message) {
  const cleanEndpoint = validateEndpoint(endpoint);
  const raw = await postJson(cleanEndpoint, token, {
    action: 'log',
    level: ['info','warning','danger'].includes(level) ? level : 'info',
    message: String(message || '').slice(0, 800),
  });
  if (!raw || raw.ok !== true) throw new Error('Server log acknowledgement was invalid.');
  return true;
}


function deriveCommandEndpoint(agentEndpoint) {
  const url = new URL(validateEndpoint(agentEndpoint));
  if (/\/agent\.php$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/agent\.php$/i, 'commands.php');
  } else {
    url.pathname = url.pathname.replace(/\/$/, '') + '/commands.php';
  }
  return url.toString();
}

async function pollCommand(commandEndpoint, token) {
  const endpoint = validateEndpoint(commandEndpoint);
  const data = await postJson(endpoint, token, { action: 'poll' }, 9000);
  if (!data || data.ok !== true) throw new Error('Hostinger command queue returned an invalid response.');
  if (data.command !== null && data.command !== undefined) {
    const command = data.command;
    if (!command || typeof command !== 'object') throw new Error('Hostinger returned a malformed command.');
    if (typeof command.uuid !== 'string' || typeof command.action !== 'string' || typeof command.capability !== 'string') {
      throw new Error('Hostinger command is missing required fields.');
    }
    if (command.args !== undefined && (command.args === null || typeof command.args !== 'object' || Array.isArray(command.args))) {
      throw new Error('Hostinger command args are invalid.');
    }
  }
  return data;
}

async function submitCommandResult(commandEndpoint, token, uuid, result) {
  const endpoint = validateEndpoint(commandEndpoint);
  return postJson(endpoint, token, { action: 'result', uuid, result }, 12000);
}

async function submitCommandError(commandEndpoint, token, uuid, error) {
  const endpoint = validateEndpoint(commandEndpoint);
  return postJson(endpoint, token, { action: 'error', uuid, error: String(error || 'Command failed').slice(0, 4000) }, 12000);
}

async function submitCommandCancelled(commandEndpoint, token, uuid) {
  const endpoint = validateEndpoint(commandEndpoint);
  return postJson(endpoint, token, { action: 'cancelled', uuid }, 12000);
}

module.exports = {
  PERMISSION_KEYS,
  validateEndpoint,
  validateHeartbeatResponse,
  deriveCommandEndpoint,
  pollCommand,
  submitCommandResult,
  submitCommandError,
  submitCommandCancelled,
  sendHeartbeat,
  sendServerLog,
};
