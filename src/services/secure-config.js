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
