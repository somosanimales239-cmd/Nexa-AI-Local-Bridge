'use strict';

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const COMMAND_SCHEMA_VERSION = 1;
const COMMAND_SUBJECT_PREFIX = '[NEXA-CMD]';
const MAX_RAW_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_COMMAND_JSON_BYTES = 6 * 1024 * 1024;
const MAX_ACTIONS = 50;
const DEFAULT_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMMAND_LIFETIME_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function randomId(prefix, bytes = 18) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

function redactMirrorText(value) {
  return String(value ?? '')
    .replace(/Authorization\s*:\s*Bearer\s+[^\s]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/nexa_[A-Za-z0-9_-]{8,}/g, '[PAIRING_TOKEN_REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[API_KEY_REDACTED]')
    .replace(/([?&](?:access_token|token|api_key|apikey|auth|authorization|k)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function sanitizeResultForMirror(value, depth = 0, key = '') {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (/password|secret|token|authorization|content_base64|\benv\b/i.test(String(key || ''))) return '[REDACTED_FIELD]';
  if (typeof value === 'string') {
    if (/^content$/i.test(String(key || ''))) return `[CONTENT_OMITTED_${Buffer.byteLength(value)}_BYTES]`;
    const safe = redactMirrorText(value);
    return safe.length > 16000 ? `${safe.slice(0,16000)}\n[TRUNCATED]` : safe;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0,100).map(item => sanitizeResultForMirror(item,depth+1,key));
  if (typeof value === 'object') {
    const out={};
    for (const [k,v] of Object.entries(value).slice(0,100)) out[k]=sanitizeResultForMirror(v,depth+1,k);
    return out;
  }
  return String(value);
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (match) return match[1].trim().toLowerCase();
  const plain = text.match(/([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  return plain ? plain[1].toLowerCase() : text;
}

function decodeMimeWord(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_all, _charset, mode, data) => {
    try {
      if (String(mode).toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      const qp = data.replace(/_/g, ' ').replace(/=([A-Fa-f0-9]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(qp, 'binary').toString('utf8');
    } catch { return data; }
  });
}

function parseHeaders(raw) {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const head = split >= 0 ? normalized.slice(0, split) : normalized;
  const body = split >= 0 ? normalized.slice(split + 2) : '';
  const unfolded = head.replace(/\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!headers[key]) headers[key] = [];
    headers[key].push(value);
  }
  return { headers, body };
}

function firstHeader(headers, key) {
  const rows = headers[String(key || '').toLowerCase()] || [];
  return rows.length ? rows[0] : '';
}

function allHeaders(headers, key) {
  return headers[String(key || '').toLowerCase()] || [];
}

function contentTypeInfo(value) {
  const text = String(value || 'text/plain');
  const type = text.split(';')[0].trim().toLowerCase() || 'text/plain';
  const boundaryMatch = text.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  return { type, boundary: boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : '' };
}

function decodeQuotedPrintable(value) {
  const text = String(value || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[A-Fa-f0-9]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const buf = Buffer.from(text[i], 'utf8');
      for (const b of buf) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeTransfer(body, encoding) {
  const mode = String(encoding || '').trim().toLowerCase();
  if (mode === 'base64') {
    try { return Buffer.from(String(body || '').replace(/\s+/g, ''), 'base64').toString('utf8'); }
    catch { return ''; }
  }
  if (mode === 'quoted-printable') return decodeQuotedPrintable(body);
  return String(body || '');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const normalized = String(body || '').replace(/\r\n/g, '\n');
  const marker = `--${boundary}`;
  const sections = normalized.split(marker);
  const parts = [];
  for (let section of sections.slice(1)) {
    section = section.replace(/^\n/, '');
    if (section.startsWith('--')) break;
    section = section.replace(/\n$/, '');
    if (section.trim()) parts.push(section);
  }
  return parts;
}

function extractTextParts(rawPart, depth = 0) {
  if (depth > 6) return [];
  const { headers, body } = parseHeaders(rawPart);
  const info = contentTypeInfo(firstHeader(headers, 'content-type'));
  if (info.type.startsWith('multipart/')) {
    return splitMultipart(body, info.boundary).flatMap(part => extractTextParts(part, depth + 1));
  }
  const decoded = decodeTransfer(body, firstHeader(headers, 'content-transfer-encoding'));
  if (info.type === 'text/plain') return [{ type: 'text/plain', text: decoded }];
  if (info.type === 'text/html') return [{ type: 'text/html', text: stripHtml(decoded) }];
  return [];
}

function parseEmail(raw) {
  if (Buffer.byteLength(String(raw || '')) > MAX_RAW_MESSAGE_BYTES) throw new Error('Remote command email exceeds the maximum accepted size.');
  const { headers } = parseHeaders(raw);
  const parts = extractTextParts(raw);
  const plain = parts.find(p => p.type === 'text/plain')?.text || parts.find(p => p.type === 'text/html')?.text || '';
  const authText = [
    ...allHeaders(headers, 'authentication-results'),
    ...allHeaders(headers, 'received-spf'),
    ...allHeaders(headers, 'arc-authentication-results'),
  ].join('\n');
  return {
    from: normalizeEmail(firstHeader(headers, 'from')),
    subject: decodeMimeWord(firstHeader(headers, 'subject')),
    messageId: firstHeader(headers, 'message-id'),
    date: firstHeader(headers, 'date'),
    authenticatedSender: /\b(?:dkim|spf|dmarc)\s*=\s*pass\b/i.test(authText) || /^pass\b/im.test(authText),
    text: plain,
    headers,
  };
}

function encodeCommandPayload(envelope) {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (json.length > MAX_COMMAND_JSON_BYTES) throw new Error('Remote command JSON is too large.');
  return zlib.gzipSync(json, { level: 9 }).toString('base64');
}

function buildCommandEmailBody(envelope) {
  const encoded = encodeCommandPayload(envelope);
  const lines = encoded.match(/.{1,76}/g) || [encoded];
  return [
    'Nexa AI Local Bridge remote command package.',
    'Do not edit the encoded block.',
    '',
    '-----BEGIN NEXA COMMAND V1-----',
    ...lines,
    '-----END NEXA COMMAND V1-----',
  ].join('\n');
}

function extractCommandEnvelope(text) {
  const match = String(text || '').match(/-----BEGIN NEXA COMMAND V1-----([\s\S]*?)-----END NEXA COMMAND V1-----/i);
  if (!match) throw new Error('No Nexa command block was found in the email body.');
  const encoded = match[1].replace(/\s+/g, '');
  let compressed;
  try { compressed = Buffer.from(encoded, 'base64'); }
  catch { throw new Error('The Nexa command block is not valid base64.'); }
  let json;
  try { json = zlib.gunzipSync(compressed, { maxOutputLength: MAX_COMMAND_JSON_BYTES }).toString('utf8'); }
  catch { throw new Error('The Nexa command block could not be decompressed.'); }
  if (Buffer.byteLength(json) > MAX_COMMAND_JSON_BYTES) throw new Error('The decoded Nexa command exceeds the maximum size.');
  try { return JSON.parse(json); }
  catch { throw new Error('The decoded Nexa command is not valid JSON.'); }
}

function validateCommandEnvelope(envelope, channelState, now = Date.now()) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Remote command envelope must be an object.');
  if (Number(envelope.schema_version) !== COMMAND_SCHEMA_VERSION) throw new Error(`Unsupported remote command schema version: ${envelope.schema_version}.`);
  if (String(envelope.channel_id || '') !== String(channelState.channel_id || '')) throw new Error('Remote command channel ID does not match this Bridge.');
  if (String(envelope.challenge || '') !== String(channelState.challenge || '')) throw new Error('Remote command challenge is invalid or stale.');
  const commandId = String(envelope.command_id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(commandId)) throw new Error('Remote command ID is missing or invalid.');
  const issued = Date.parse(String(envelope.issued_at || ''));
  const expires = Date.parse(String(envelope.expires_at || ''));
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) throw new Error('Remote command issued_at/expires_at timestamps are required.');
  if (issued > now + CLOCK_SKEW_MS) throw new Error('Remote command issued_at is too far in the future.');
  if (now > expires) throw new Error('Remote command has expired.');
  if (expires - issued > MAX_COMMAND_LIFETIME_MS) throw new Error('Remote command lifetime is longer than allowed.');
  if (!Array.isArray(envelope.actions) || envelope.actions.length < 1 || envelope.actions.length > MAX_ACTIONS) throw new Error(`Remote command must contain 1-${MAX_ACTIONS} actions.`);
  for (const [index, action] of envelope.actions.entries()) {
    if (!action || typeof action !== 'object' || typeof action.action !== 'string' || !action.action.trim()) {
      throw new Error(`Remote command action ${index + 1} is invalid.`);
    }
  }
  return { ...envelope, command_id: commandId };
}

class Pop3Connection {
  constructor({ host, port = 995, timeoutMs = 12000 }) {
    this.host = String(host || '').trim();
    this.port = Number(port || 995);
    this.timeoutMs = Math.max(3000, Math.min(Number(timeoutMs || 12000), 30000));
    this.socket = null;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.failed = null;
  }

  pushData(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }

  fail(error) {
    this.failed = error instanceof Error ? error : new Error(String(error || 'POP3 connection failed.'));
    while (this.waiters.length) this.waiters.shift().reject(this.failed);
  }

  nextLine() {
    if (this.failed) return Promise.reject(this.failed);
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async connect() {
    if (!this.host || !/^[A-Za-z0-9.-]+$/.test(this.host)) throw new Error('A valid POP3 host is required.');
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('A valid POP3 port is required.');
    await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.host,
        port: this.port,
        servername: this.host,
        rejectUnauthorized: true,
      }, resolve);
      this.socket = socket;
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('POP3 connection timed out.')));
      socket.on('data', chunk => this.pushData(chunk));
      socket.on('error', error => { this.fail(error); reject(error); });
      socket.on('close', () => { if (!this.failed) this.fail(new Error('POP3 connection closed.')); });
    });
    const greeting = await this.nextLine();
    if (!greeting.startsWith('+OK')) throw new Error(`POP3 server rejected the connection: ${greeting.slice(0, 200)}`);
    return greeting;
  }

  async command(command, multiline = false) {
    if (!this.socket || this.socket.destroyed) throw new Error('POP3 connection is not open.');
    this.socket.write(`${command}\r\n`);
    const first = await this.nextLine();
    if (!first.startsWith('+OK')) throw new Error(`POP3 command failed: ${first.slice(0, 300)}`);
    if (!multiline) return first;
    const rows = [];
    while (true) {
      const line = await this.nextLine();
      if (line === '.') break;
      rows.push(line.startsWith('..') ? line.slice(1) : line);
      if (rows.reduce((n, item) => n + item.length + 2, 0) > MAX_RAW_MESSAGE_BYTES + 1024 * 1024) {
        throw new Error('POP3 response exceeded the safety size limit.');
      }
    }
    return rows;
  }

  async login(username, password) {
    const user = String(username || '').trim();
    if (!user || !password) throw new Error('POP3 mailbox username and password are required.');
    await this.command(`USER ${user}`);
    await this.command(`PASS ${String(password)}`);
  }

  close() {
    try {
      if (this.socket && !this.socket.destroyed) {
        this.socket.write('QUIT\r\n');
        this.socket.end();
      }
    } catch {}
  }
}

async function testPop3Mailbox({ host, port, username, password }) {
  const conn = new Pop3Connection({ host, port });
  try {
    await conn.connect();
    await conn.login(username, password);
    const list = await conn.command('STAT');
    const match = String(list).match(/^\+OK\s+(\d+)\s+(\d+)/i);
    return { ok: true, message_count: match ? Number(match[1]) : null, total_bytes: match ? Number(match[2]) : null };
  } finally {
    conn.close();
  }
}

class RemoteCommandInbox {
  constructor({ userDataPath, logger }) {
    this.userDataPath = userDataPath;
    this.logger = logger;
    this.channelFile = path.join(userDataPath, 'remote-command-channel.json');
    this.ledgerFile = path.join(userDataPath, 'remote-command-ledger.json');
    this.historyFile = path.join(userDataPath, 'remote-command-history.json');
    this.status = {
      state: 'idle',
      last_check_at: '',
      last_command_id: '',
      last_command_status: '',
      last_error: '',
      processed_count: 0,
    };
    this.channel = this.loadOrCreateChannel();
  }

  loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
  }

  writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  loadOrCreateChannel() {
    const existing = this.loadJson(this.channelFile, {});
    const channel = {
      schema_version: COMMAND_SCHEMA_VERSION,
      channel_id: /^[A-Za-z0-9_.:-]{12,128}$/.test(String(existing.channel_id || '')) ? existing.channel_id : randomId('channel', 16),
      challenge: /^[A-Za-z0-9_.:-]{12,256}$/.test(String(existing.challenge || '')) ? existing.challenge : randomId('challenge', 24),
      challenge_created_at: existing.challenge_created_at || new Date().toISOString(),
      challenge_expires_at: existing.challenge_expires_at || new Date(Date.now() + DEFAULT_CHALLENGE_TTL_MS).toISOString(),
    };
    if (Date.parse(channel.challenge_expires_at) <= Date.now()) {
      channel.challenge = randomId('challenge', 24);
      channel.challenge_created_at = new Date().toISOString();
      channel.challenge_expires_at = new Date(Date.now() + DEFAULT_CHALLENGE_TTL_MS).toISOString();
    }
    this.writeJson(this.channelFile, channel);
    return channel;
  }

  rotateChallenge() {
    this.channel = {
      ...this.channel,
      challenge: randomId('challenge', 24),
      challenge_created_at: new Date().toISOString(),
      challenge_expires_at: new Date(Date.now() + DEFAULT_CHALLENGE_TTL_MS).toISOString(),
    };
    this.writeJson(this.channelFile, this.channel);
    return this.channel;
  }

  getLedger() {
    const ledger = this.loadJson(this.ledgerFile, { uidls: [], command_ids: [] });
    return {
      uidls: Array.isArray(ledger.uidls) ? ledger.uidls.slice(-5000) : [],
      command_ids: Array.isArray(ledger.command_ids) ? ledger.command_ids.slice(-5000) : [],
    };
  }

  saveLedger(ledger) {
    this.writeJson(this.ledgerFile, {
      uidls: Array.from(new Set(ledger.uidls || [])).slice(-5000),
      command_ids: Array.from(new Set(ledger.command_ids || [])).slice(-5000),
      updated_at: new Date().toISOString(),
    });
  }

  appendHistory(row) {
    const history = this.loadJson(this.historyFile, []);
    const next = [row, ...(Array.isArray(history) ? history : [])].slice(0, 30);
    this.writeJson(this.historyFile, next);
  }

  getPublicStatus({ enabled = false, configured = false, pollSeconds = 15, policy = null } = {}) {
    return {
      schema_version: COMMAND_SCHEMA_VERSION,
      transport: 'pop3s-email',
      enabled: enabled === true,
      configured: configured === true,
      poll_seconds: pollSeconds,
      channel_id: this.channel.channel_id,
      challenge: this.channel.challenge,
      challenge_created_at: this.channel.challenge_created_at,
      challenge_expires_at: this.channel.challenge_expires_at,
      command_subject_prefix: COMMAND_SUBJECT_PREFIX,
      supported_delivery: 'gzip+base64 command block in text email body',
      security: {
        tls_certificate_validation: true,
        exact_sender_allowlist: true,
        sender_authentication_header_check: true,
        one_time_challenge: true,
        command_expiration: true,
        replay_ledger: true,
        hostinger_permission_gates: true,
        allowed_folder_enforcement: true,
        transactional_file_backups: true,
      },
      policy: policy ? {
        bridge_enabled: policy.bridgeEnabled === true,
        emergency_stop: policy.emergencyStop === true,
        full_computer_mode: policy.fullComputerMode === true,
        permissions: { ...(policy.permissions || {}) },
      } : undefined,
      ...this.status,
    };
  }

  writeProjectStatus(unityRoots, publicStatus, result = null) {
    for (const root of Array.isArray(unityRoots) ? unityRoots : []) {
      try {
        const dir = path.join(path.resolve(root), '.nexa-bridge');
        fs.mkdirSync(dir, { recursive: true });
        const channel = { ...publicStatus };
        delete channel.last_error;
        this.writeJson(path.join(dir, 'remote-channel.json'), channel);
        const history = this.loadJson(this.historyFile, []);
        this.writeJson(path.join(dir, 'remote-command-history.json'), Array.isArray(history) ? history.slice(0, 20) : []);
        if (result) this.writeJson(path.join(dir, 'remote-command-status.json'), result);
      } catch {}
    }
  }

  async poll({ config, password, policy, unityRoots, executeEnvelope }) {
    const nowIso = new Date().toISOString();
    this.status.last_check_at = nowIso;
    this.status.last_error = '';
    if (!config?.remoteInboxEnabled) return { ok: true, processed: 0, reason: 'disabled' };
    if (!config?.remoteInboxConfigured || !password) throw new Error('Remote Command Inbox password is not configured.');
    if (!policy?.authenticated || !policy?.bridgeEnabled || policy?.emergencyStop) throw new Error('Remote Command Inbox is blocked by current Hostinger policy.');

    const conn = new Pop3Connection({ host: config.remoteInboxHost, port: config.remoteInboxPort });
    const ledger = this.getLedger();
    const knownUidls = new Set(ledger.uidls);
    const knownCommands = new Set(ledger.command_ids);
    let processed = 0;
    try {
      this.status.state = 'checking';
      await conn.connect();
      await conn.login(config.remoteInboxUsername, password);
      const uidlRows = await conn.command('UIDL', true);
      const entries = uidlRows.map(line => {
        const match = String(line).match(/^(\d+)\s+(.+)$/);
        return match ? { number: Number(match[1]), uidl: match[2].trim() } : null;
      }).filter(Boolean).filter(row => !knownUidls.has(row.uidl)).slice(-20);

      for (const entry of entries) {
        let markUidl = false;
        try {
          const rawRows = await conn.command(`RETR ${entry.number}`, true);
          markUidl = true;
          const raw = rawRows.join('\r\n');
          const email = parseEmail(raw);
          if (!String(email.subject || '').trim().startsWith(COMMAND_SUBJECT_PREFIX)) continue;
          if (normalizeEmail(email.from) !== normalizeEmail(config.remoteInboxAllowedSender)) {
            throw new Error(`Rejected remote command from non-allowlisted sender: ${email.from || 'unknown'}.`);
          }
          if (config.remoteInboxRequireAuth !== false && !email.authenticatedSender) {
            throw new Error('Rejected remote command because SPF/DKIM/DMARC pass evidence was not present in the received headers.');
          }
          const envelope = validateCommandEnvelope(extractCommandEnvelope(email.text), this.channel);
          if (knownCommands.has(envelope.command_id)) throw new Error(`Remote command replay blocked: ${envelope.command_id}.`);

          this.rotateChallenge();
          this.status.state = 'executing';
          this.status.last_command_id = envelope.command_id;
          this.status.last_command_status = 'running';
          this.writeProjectStatus(unityRoots, this.getPublicStatus({ enabled:true, configured:true, pollSeconds:config.remoteInboxPollSeconds, policy }), {
            schema_version: COMMAND_SCHEMA_VERSION,
            command_id: envelope.command_id,
            status: 'running',
            started_at: new Date().toISOString(),
            action_count: envelope.actions.length,
          });

          const started = Date.now();
          const result = await executeEnvelope(envelope);
          const summary = {
            schema_version: COMMAND_SCHEMA_VERSION,
            command_id: envelope.command_id,
            status: result?.ok === false ? 'failed' : 'completed',
            started_at: new Date(started).toISOString(),
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - started,
            action_count: envelope.actions.length,
            result: sanitizeResultForMirror(result || null),
          };
          this.status.last_command_status = summary.status;
          this.status.processed_count += 1;
          knownCommands.add(envelope.command_id);
          ledger.command_ids.push(envelope.command_id);
          this.appendHistory({
            command_id: envelope.command_id,
            status: summary.status,
            completed_at: summary.completed_at,
            duration_ms: summary.duration_ms,
            action_count: summary.action_count,
            changed_files: Array.isArray(result?.changed_files) ? result.changed_files.slice(0, 50) : [],
            rollback: result?.rollback || null,
            compile: result?.compile || null,
          });
          this.writeProjectStatus(unityRoots, this.getPublicStatus({ enabled:true, configured:true, pollSeconds:config.remoteInboxPollSeconds, policy }), summary);
          processed += 1;
        } catch (error) {
          this.status.last_error = error.message;
          this.status.last_command_status = 'rejected_or_failed';
          this.logger?.log('warning', 'remote-inbox', error.message);
          this.appendHistory({ command_id: '', status:'rejected_or_failed', completed_at:new Date().toISOString(), error:error.message.slice(0,500) });
        } finally {
          if (markUidl) {
            knownUidls.add(entry.uidl);
            ledger.uidls.push(entry.uidl);
          }
        }
        if (processed >= 5) break;
      }

      this.saveLedger(ledger);
      this.status.state = 'idle';
      this.writeProjectStatus(unityRoots, this.getPublicStatus({ enabled:true, configured:true, pollSeconds:config.remoteInboxPollSeconds, policy }));
      return { ok: true, processed };
    } finally {
      conn.close();
      if (this.status.state === 'checking') this.status.state = 'idle';
    }
  }
}

module.exports = {
  COMMAND_SCHEMA_VERSION,
  COMMAND_SUBJECT_PREFIX,
  parseHeaders,
  parseEmail,
  encodeCommandPayload,
  buildCommandEmailBody,
  extractCommandEnvelope,
  validateCommandEnvelope,
  Pop3Connection,
  testPop3Mailbox,
  RemoteCommandInbox,
  normalizeEmail,
  sanitizeResultForMirror,
};
