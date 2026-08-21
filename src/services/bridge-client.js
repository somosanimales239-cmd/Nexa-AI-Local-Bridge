'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

const PERMISSION_KEYS = [
  'read_files','write_files','cmd','powershell','python',
  'git','browser','screenshots','blender','local_servers'
];

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

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

function friendlyNetworkError(error, endpoint) {
  const code = String(error?.code || '').toUpperCase();
  const host = (() => { try { return new URL(endpoint).hostname; } catch { return 'Hostinger'; } })();
  let message;

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    message = `DNS could not resolve ${host}.`;
  } else if (code === 'ECONNRESET') {
    message = `Hostinger reset the HTTPS connection to ${host}.`;
  } else if (code === 'ECONNREFUSED') {
    message = `The HTTPS connection to ${host} was refused.`;
  } else if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'NEXA_TIMEOUT') {
    message = `Connection timed out while contacting ${host}.`;
  } else if (code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL')) {
    message = `TLS certificate validation failed while contacting ${host}.`;
  } else {
    message = error?.message ? `Network error while contacting ${host}: ${error.message}` : `Network error while contacting ${host}.`;
  }

  const wrapped = new Error(message);
  wrapped.code = code || 'NETWORK_ERROR';
  wrapped.cause = error;
  return wrapped;
}

/**
 * Windows/Hostinger-safe JSON transport.
 *
 * Electron/Node fetch can choose a network path that behaves differently from
 * Windows curl on some CDN/DNS combinations. The bridge therefore uses a
 * deterministic HTTP/1.1 request, forces IPv4 for production HTTPS, disables
 * connection reuse, and applies an explicit timeout.
 */
function requestJsonHttp11(endpoint, token, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(validateEndpoint(endpoint));
    const body = JSON.stringify(payload);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    let settled = false;

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      agent: false,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Nexa-AI-Local-Bridge/1.2.2',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
        'Cache-Control': 'no-cache',
      },
      ...(isHttps ? {
        servername: url.hostname,
        ALPNProtocols: ['http/1.1'],
        minVersion: 'TLSv1.2',
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 250,
      } : {}),
    };

    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(friendlyNetworkError(error, endpoint));
    };

    const request = transport.request(options, response => {
      const chunks = [];
      let bytes = 0;

      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          const error = new Error('Hostinger response exceeded the safe JSON response limit.');
          error.code = 'RESPONSE_TOO_LARGE';
          request.destroy(error);
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: Number(response.statusCode || 0),
          headers: response.headers || {},
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });

      response.on('error', finishReject);
    });

    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Timed out after ${timeoutMs} ms`);
      error.code = 'NEXA_TIMEOUT';
      request.destroy(error);
    });

    request.on('socket', socket => {
      socket.setKeepAlive(false);
      socket.setNoDelay(true);
    });
    request.on('error', finishReject);
    request.end(body);
  });
}


const curlPreferredHosts = new Set();

function quoteCurlConfigValue(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function shouldUseCurlFallback(error, endpoint) {
  if (process.platform !== 'win32') return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const code = String(error?.code || '').toUpperCase();
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'NEXA_TIMEOUT'].includes(code);
}

/**
 * Windows fallback using the inbox curl.exe client.
 * The bearer token and JSON body are passed through curl config on stdin,
 * not on the process command line, so secrets do not appear in argv.
 */
function requestJsonWithWindowsCurl(endpoint, token, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cleanEndpoint = validateEndpoint(endpoint);
    const body = JSON.stringify(payload);
    const maxSeconds = Math.max(5, Math.ceil(timeoutMs / 1000));
    const connectSeconds = Math.min(10, maxSeconds);
    const statusMarker = 'NEXA_HTTP_STATUS:';
    const config = [
      `url = ${quoteCurlConfigValue(cleanEndpoint)}`,
      'request = "POST"',
      'http1.1',
      'silent',
      'show-error',
      'location',
      'max-redirs = 3',
      `connect-timeout = ${connectSeconds}`,
      `max-time = ${maxSeconds}`,
      `header = ${quoteCurlConfigValue(`Authorization: Bearer ${token}`)}`,
      `header = ${quoteCurlConfigValue('Content-Type: application/json')}`,
      `header = ${quoteCurlConfigValue('Accept: application/json')}`,
      `header = ${quoteCurlConfigValue('User-Agent: Nexa-AI-Local-Bridge/1.2.2')}`,
      `header = ${quoteCurlConfigValue('Connection: close')}`,
      `data-binary = ${quoteCurlConfigValue(body)}`,
      `write-out = ${quoteCurlConfigValue(`\\n${statusMarker}%{http_code}`)}`,
      '',
    ].join('\n');

    const child = spawn('curl.exe', ['--config', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;

    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(friendlyNetworkError(error, endpoint));
    };

    const hardTimer = setTimeout(() => {
      const error = new Error(`curl.exe timed out after ${timeoutMs} ms`);
      error.code = 'NEXA_TIMEOUT';
      try { child.kill(); } catch {}
      finishReject(error);
    }, timeoutMs + 2500);

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RESPONSE_BYTES + 8192) {
        const error = new Error('Hostinger response exceeded the safe JSON response limit.');
        error.code = 'RESPONSE_TOO_LARGE';
        try { child.kill(); } catch {}
        finishReject(error);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearTimeout(hardTimer);
      if (error && error.code === 'ENOENT') {
        const wrapped = new Error('Windows curl.exe is unavailable and the Node HTTPS connection also failed.');
        wrapped.code = 'CURL_UNAVAILABLE';
        finishReject(wrapped);
        return;
      }
      finishReject(error);
    });
    child.on('close', code => {
      clearTimeout(hardTimer);
      if (settled) return;
      const output = Buffer.concat(stdout).toString('utf8');
      const markerIndex = output.lastIndexOf(`\n${statusMarker}`);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (markerIndex < 0) {
        const error = new Error(errorText || `curl.exe exited with code ${code}.`);
        error.code = code === 6 ? 'ENOTFOUND' : code === 28 ? 'NEXA_TIMEOUT' : code === 35 ? 'TLS_ERROR' : 'CURL_ERROR';
        finishReject(error);
        return;
      }
      const text = output.slice(0, markerIndex);
      const status = Number(output.slice(markerIndex + 1 + statusMarker.length).trim());
      if (!Number.isFinite(status) || status <= 0) {
        const error = new Error(errorText || 'curl.exe did not return an HTTP status.');
        error.code = 'CURL_ERROR';
        finishReject(error);
        return;
      }
      settled = true;
      resolve({ status, headers: {}, text, transport: 'windows-curl' });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(config);
  });
}

async function requestJsonResilient(endpoint, token, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const host = (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })();
  if (host && curlPreferredHosts.has(host) && process.platform === 'win32') {
    return requestJsonWithWindowsCurl(endpoint, token, payload, timeoutMs);
  }
  try {
    return await requestJsonHttp11(endpoint, token, payload, Math.min(timeoutMs, 12_000));
  } catch (error) {
    if (!shouldUseCurlFallback(error, endpoint)) throw error;
    const response = await requestJsonWithWindowsCurl(endpoint, token, payload, timeoutMs);
    if (host) curlPreferredHosts.add(host);
    return response;
  }
}

async function postJson(endpoint, token, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await requestJsonResilient(endpoint, token, payload, timeoutMs);

  let data = null;
  if (response.text) {
    try { data = JSON.parse(response.text); } catch {}
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
  if (response.status < 200 || response.status >= 300) {
    const detail = data && typeof data.error === 'string' ? ` ${data.error}` : '';
    const error = new Error(`Hostinger returned HTTP ${response.status}.${detail}`.trim());
    error.code = response.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
    throw error;
  }
  if (!data) throw new Error('Hostinger returned malformed JSON.');
  return data;
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
  const data = await postJson(endpoint, token, { action: 'poll' }, 20_000);
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
  return postJson(endpoint, token, { action: 'result', uuid, result }, 25_000);
}

async function submitCommandError(commandEndpoint, token, uuid, error) {
  const endpoint = validateEndpoint(commandEndpoint);
  return postJson(endpoint, token, { action: 'error', uuid, error: String(error || 'Command failed').slice(0, 4000) }, 25_000);
}

async function submitCommandCancelled(commandEndpoint, token, uuid) {
  const endpoint = validateEndpoint(commandEndpoint);
  return postJson(endpoint, token, { action: 'cancelled', uuid }, 25_000);
}

module.exports = {
  PERMISSION_KEYS,
  validateEndpoint,
  validateHeartbeatResponse,
  requestJsonHttp11,
  requestJsonWithWindowsCurl,
  requestJsonResilient,
  postJson,
  deriveCommandEndpoint,
  pollCommand,
  submitCommandResult,
  submitCommandError,
  submitCommandCancelled,
  sendHeartbeat,
  sendServerLog,
};
