'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function commandFingerprint(command) {
  const normalized = {
    uuid: String(command?.uuid || ''),
    action: String(command?.action || ''),
    capability: String(command?.capability || ''),
    args: command?.args && typeof command.args === 'object' ? command.args : {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

class HostingerCommandLedger {
  constructor({ file, maxEntries = 250 }) {
    if (!file) throw new Error('HostingerCommandLedger requires a file path.');
    this.file = file;
    this.maxEntries = Math.max(25, Number(maxEntries || 250));
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') throw new Error('invalid ledger');
      return parsed;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  write(state) {
    const entries = Object.entries(state.entries || {})
      .sort((a, b) => String(b[1]?.updated_at || '').localeCompare(String(a[1]?.updated_at || '')))
      .slice(0, this.maxEntries);
    const next = { version: 1, entries: Object.fromEntries(entries) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  inspect(command) {
    const uuid = String(command?.uuid || '').trim();
    if (!uuid) throw new Error('Hostinger command UUID is required.');
    const state = this.read();
    const current = state.entries[uuid] || null;
    if (!current) return { mode: 'new', entry: null };
    const fingerprint = commandFingerprint(command);
    if (current.fingerprint !== fingerprint) {
      return { mode: 'conflict', entry: current };
    }
    if (current.state === 'final') return { mode: 'replay', entry: current };
    if (current.state === 'inflight') return { mode: 'uncertain', entry: current };
    return { mode: 'new', entry: current };
  }

  begin(command) {
    const uuid = String(command?.uuid || '').trim();
    const decision = this.inspect(command);
    if (decision.mode !== 'new') return decision;
    const state = this.read();
    const now = new Date().toISOString();
    state.entries[uuid] = {
      uuid,
      action: String(command?.action || ''),
      fingerprint: commandFingerprint(command),
      state: 'inflight',
      started_at: now,
      updated_at: now,
    };
    this.write(state);
    return { mode: 'execute', entry: state.entries[uuid] };
  }

  finish(command, kind, payload) {
    const uuid = String(command?.uuid || '').trim();
    if (!uuid) throw new Error('Hostinger command UUID is required.');
    if (!['result', 'error', 'cancelled'].includes(kind)) throw new Error('Invalid Hostinger command final kind.');
    const state = this.read();
    const now = new Date().toISOString();
    state.entries[uuid] = {
      ...(state.entries[uuid] || {}),
      uuid,
      action: String(command?.action || ''),
      fingerprint: commandFingerprint(command),
      state: 'final',
      final_kind: kind,
      payload,
      finished_at: now,
      updated_at: now,
    };
    this.write(state);
    return state.entries[uuid];
  }
}

module.exports = { HostingerCommandLedger, commandFingerprint };
