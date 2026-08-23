'use strict';

const fs = require('fs');
const path = require('path');

class SecureConfig {
  constructor({ userDataPath, safeStorage }) {
    this.safeStorage = safeStorage;
    this.file = path.join(userDataPath, 'nexa-local-bridge-config.json');
  }

  readRaw() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  publicConfig() {
    const raw = this.readRaw();
    return {
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
      deviceLabel: typeof raw.deviceLabel === 'string' ? raw.deviceLabel : '',
      autoConnect: raw.autoConnect === true,
      startWithWindows: raw.startWithWindows === true,
      allowedRoots: Array.isArray(raw.allowedRoots) ? raw.allowedRoots.filter(v => typeof v === 'string') : [],
      unityRoots: Array.isArray(raw.unityRoots) ? raw.unityRoots.filter(v => typeof v === 'string') : [],
      workspaceSyncEnabled: raw.workspaceSyncEnabled === true,
      autoCaptureUnity: raw.autoCaptureUnity === true,
      githubRepo: typeof raw.githubRepo === 'string' ? raw.githubRepo : 'somosanimales239-cmd/Nexa-AI-Local-Bridge',
      githubBranch: typeof raw.githubBranch === 'string' ? raw.githubBranch : 'nexa-unity-workspace',
      githubSyncEnabled: raw.githubSyncEnabled === true,
      githubApplyEnabled: raw.githubApplyEnabled === true,
      githubConfigured: typeof raw.githubTokenEncrypted === 'string' && raw.githubTokenEncrypted.length > 0,
      remoteInboxEnabled: raw.remoteInboxEnabled === true,
      remoteInboxHost: typeof raw.remoteInboxHost === 'string' && raw.remoteInboxHost.trim() ? raw.remoteInboxHost.trim() : 'pop.hostinger.com',
      remoteInboxPort: Number.isInteger(raw.remoteInboxPort) ? raw.remoteInboxPort : 995,
      remoteInboxUsername: typeof raw.remoteInboxUsername === 'string' ? raw.remoteInboxUsername : '',
      remoteInboxAllowedSender: typeof raw.remoteInboxAllowedSender === 'string' ? raw.remoteInboxAllowedSender : '',
      remoteInboxPollSeconds: Number.isFinite(raw.remoteInboxPollSeconds) ? Math.max(10, Math.min(Number(raw.remoteInboxPollSeconds), 300)) : 15,
      remoteInboxRequireAuth: raw.remoteInboxRequireAuth !== false,
      remoteInboxSmtpHost: typeof raw.remoteInboxSmtpHost === 'string' && raw.remoteInboxSmtpHost.trim() ? raw.remoteInboxSmtpHost.trim() : 'smtp.hostinger.com',
      remoteInboxSmtpPort: Number.isInteger(raw.remoteInboxSmtpPort) ? raw.remoteInboxSmtpPort : 465,
      remoteInboxSendResults: raw.remoteInboxSendResults !== false,
      remoteInboxResultRecipient: typeof raw.remoteInboxResultRecipient === 'string' && raw.remoteInboxResultRecipient.trim() ? raw.remoteInboxResultRecipient.trim() : (typeof raw.remoteInboxAllowedSender === 'string' ? raw.remoteInboxAllowedSender : ''),
      remoteInboxConfigured: typeof raw.remoteInboxPasswordEncrypted === 'string' && raw.remoteInboxPasswordEncrypted.length > 0,
      paired: typeof raw.tokenEncrypted === 'string' && raw.tokenEncrypted.length > 0,
    };
  }

  getToken() {
    const raw = this.readRaw();
    if (!raw.tokenEncrypted) return '';
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure token storage is unavailable on this Windows session.');
    }
    try {
      const encrypted = Buffer.from(raw.tokenEncrypted, 'base64');
      return this.safeStorage.decryptString(encrypted);
    } catch {
      throw new Error('The stored pairing token could not be decrypted.');
    }
  }


  getGithubToken() {
    const raw = this.readRaw();
    if (!raw.githubTokenEncrypted) return '';
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure GitHub token storage is unavailable on this Windows session.');
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(raw.githubTokenEncrypted, 'base64'));
    } catch {
      throw new Error('The stored GitHub token could not be decrypted.');
    }
  }

  saveGithub({ repo, branch, token, syncEnabled, applyEnabled }) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure GitHub token storage is unavailable.');
    const raw = this.readRaw();
    let githubTokenEncrypted = raw.githubTokenEncrypted || '';
    if (typeof token === 'string' && token.trim()) {
      githubTokenEncrypted = this.safeStorage.encryptString(token.trim()).toString('base64');
    }
    if (!githubTokenEncrypted) throw new Error('Enter a GitHub fine-grained token before saving GitHub Workspace.');
    const next = {
      ...raw,
      githubRepo: String(repo || '').trim(),
      githubBranch: String(branch || '').trim(),
      githubTokenEncrypted,
      githubSyncEnabled: syncEnabled === true,
      githubApplyEnabled: applyEnabled === true,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return this.publicConfig();
  }

  getRemoteInboxPassword() {
    const raw = this.readRaw();
    if (!raw.remoteInboxPasswordEncrypted) return '';
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure Remote Command Inbox password storage is unavailable on this Windows session.');
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(raw.remoteInboxPasswordEncrypted, 'base64'));
    } catch {
      throw new Error('The stored Remote Command Inbox password could not be decrypted.');
    }
  }

  saveRemoteInbox({ enabled, host, port, username, password, allowedSender, pollSeconds, requireAuth, smtpHost, smtpPort, sendResults, resultRecipient }) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure Remote Command Inbox password storage is unavailable.');
    const raw = this.readRaw();
    let encrypted = raw.remoteInboxPasswordEncrypted || '';
    if (typeof password === 'string' && password.trim()) {
      encrypted = this.safeStorage.encryptString(password).toString('base64');
    }
    if (!encrypted) throw new Error('Enter the password for the dedicated command mailbox before saving.');
    const cleanHost = String(host || '').trim();
    const cleanUser = String(username || '').trim();
    const cleanSender = String(allowedSender || '').trim();
    const cleanPort = Number(port || 995);
    const cleanSmtpHost = String(smtpHost || raw.remoteInboxSmtpHost || 'smtp.hostinger.com').trim();
    const cleanSmtpPort = Number(smtpPort || raw.remoteInboxSmtpPort || 465);
    const cleanResultRecipient = String(resultRecipient || cleanSender).trim();
    if (!/^[A-Za-z0-9.-]+$/.test(cleanHost)) throw new Error('Enter a valid POP3 host.');
    if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) throw new Error('Enter a valid POP3 port.');
    if (!cleanUser || !cleanSender) throw new Error('Command mailbox username and allowed sender are required.');
    if (!/^[A-Za-z0-9.-]+$/.test(cleanSmtpHost)) throw new Error('Enter a valid SMTP host.');
    if (!Number.isInteger(cleanSmtpPort) || cleanSmtpPort < 1 || cleanSmtpPort > 65535) throw new Error('Enter a valid SMTP port.');
    if (sendResults !== false && !cleanResultRecipient) throw new Error('A result recipient email is required when SMTP result delivery is enabled.');
    const next = {
      ...raw,
      remoteInboxEnabled: enabled === true,
      remoteInboxHost: cleanHost,
      remoteInboxPort: cleanPort,
      remoteInboxUsername: cleanUser,
      remoteInboxPasswordEncrypted: encrypted,
      remoteInboxAllowedSender: cleanSender,
      remoteInboxPollSeconds: Math.max(10, Math.min(Number(pollSeconds || 15), 300)),
      remoteInboxRequireAuth: requireAuth !== false,
      remoteInboxSmtpHost: cleanSmtpHost,
      remoteInboxSmtpPort: cleanSmtpPort,
      remoteInboxSendResults: sendResults !== false,
      remoteInboxResultRecipient: cleanResultRecipient,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return this.publicConfig();
  }

  clearRemoteInbox() {
    const raw = this.readRaw();
    const next = { ...raw };
    delete next.remoteInboxPasswordEncrypted;
    next.remoteInboxEnabled = false;
    next.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return this.publicConfig();
  }

  savePairing({ endpoint, deviceLabel, token, autoConnect, startWithWindows, allowedRoots, unityRoots, workspaceSyncEnabled, autoCaptureUnity }) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure token storage is unavailable. The pairing token was not saved.');
    }
    const encrypted = this.safeStorage.encryptString(token).toString('base64');
    const raw = this.readRaw();
    const next = {
      ...raw,
      endpoint,
      deviceLabel,
      tokenEncrypted: encrypted,
      autoConnect: autoConnect === true,
      startWithWindows: startWithWindows === true,
      allowedRoots: Array.isArray(allowedRoots) ? allowedRoots : [],
      unityRoots: Array.isArray(unityRoots) ? unityRoots : [],
      workspaceSyncEnabled: workspaceSyncEnabled === true,
      autoCaptureUnity: autoCaptureUnity === true,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  updatePreferences(patch) {
    const raw = this.readRaw();
    const next = {
      ...raw,
      autoConnect: patch.autoConnect === undefined ? raw.autoConnect === true : patch.autoConnect === true,
      startWithWindows: patch.startWithWindows === undefined ? raw.startWithWindows === true : patch.startWithWindows === true,
      allowedRoots: patch.allowedRoots === undefined
        ? (Array.isArray(raw.allowedRoots) ? raw.allowedRoots : [])
        : (Array.isArray(patch.allowedRoots) ? patch.allowedRoots : []),
      unityRoots: patch.unityRoots === undefined
        ? (Array.isArray(raw.unityRoots) ? raw.unityRoots : [])
        : (Array.isArray(patch.unityRoots) ? patch.unityRoots : []),
      workspaceSyncEnabled: patch.workspaceSyncEnabled === undefined ? raw.workspaceSyncEnabled === true : patch.workspaceSyncEnabled === true,
      autoCaptureUnity: patch.autoCaptureUnity === undefined ? raw.autoCaptureUnity === true : patch.autoCaptureUnity === true,
      githubSyncEnabled: patch.githubSyncEnabled === undefined ? raw.githubSyncEnabled === true : patch.githubSyncEnabled === true,
      githubApplyEnabled: patch.githubApplyEnabled === undefined ? raw.githubApplyEnabled === true : patch.githubApplyEnabled === true,
      remoteInboxEnabled: patch.remoteInboxEnabled === undefined ? raw.remoteInboxEnabled === true : patch.remoteInboxEnabled === true,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return this.publicConfig();
  }

  clearPairing() {
    try { fs.rmSync(this.file, { force: true }); } catch {}
  }
}

module.exports = { SecureConfig };
