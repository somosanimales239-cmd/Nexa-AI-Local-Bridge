'use strict';

const fs = require('fs');
const path = require('path');

class SafeLogger {
  constructor(logDir) {
    this.logDir = logDir;
    this.logFile = path.join(logDir, 'nexa-ai-local-bridge.log');
    fs.mkdirSync(logDir, { recursive: true });
  }

  redact(value) {
    return String(value ?? '')
      .replace(/(^|\s)(-accessToken(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gim, '$1$2[UNITY_TOKEN_REDACTED]')
      .replace(/Authorization\s*:\s*Bearer\s+[^\s]+/gi, 'Authorization: Bearer [REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]')
      .replace(/nexa_[A-Za-z0-9_-]{8,}/g, '[PAIRING_TOKEN_REDACTED]')
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[API_KEY_REDACTED]')
      .replace(/\bws_[A-Za-z0-9_-]{24,}\b/g, '[WORKSPACE_KEY_REDACTED]')
      .replace(/([?&](?:access_token|token|api_key|apikey|auth|authorization|k)=)[^&#\s]+/gi, '$1[REDACTED]');
  }

  rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const stat = fs.statSync(this.logFile);
      if (stat.size < 1024 * 1024) return;
      const backup = `${this.logFile}.1`;
      try { fs.rmSync(backup, { force: true }); } catch {}
      fs.renameSync(this.logFile, backup);
    } catch {}
  }

  log(level, event, message) {
    this.rotateIfNeeded();
    const row = {
      timestamp: new Date().toISOString(),
      level: this.redact(level || 'info'),
      event: this.redact(event || 'app'),
      message: this.redact(message || ''),
    };
    try {
      fs.appendFileSync(this.logFile, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {}
    return row;
  }
}

module.exports = { SafeLogger };
