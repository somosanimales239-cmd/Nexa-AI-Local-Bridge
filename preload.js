'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexaBridge', Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
  getState: () => ipcRenderer.invoke('bridge:get-state'),
  testConnection: payload => ipcRenderer.invoke('bridge:test', payload),
  connect: payload => ipcRenderer.invoke('bridge:connect', payload),
  disconnect: () => ipcRenderer.invoke('bridge:disconnect'),
  reconnect: () => ipcRenderer.invoke('bridge:reconnect'),
  updatePreferences: payload => ipcRenderer.invoke('bridge:update-preferences', payload),
  unpair: () => ipcRenderer.invoke('bridge:unpair'),
  openLogs: () => ipcRenderer.invoke('bridge:open-logs'),
  syncWorkspaceNow: () => ipcRenderer.invoke('bridge:workspace-sync-now'),
  installUnityIntegration: root => ipcRenderer.invoke('bridge:unity-install', root),
  captureUnityViews: root => ipcRenderer.invoke('bridge:unity-capture', root),
  saveGithubWorkspace: payload => ipcRenderer.invoke('bridge:github-save', payload),
  testGithubWorkspace: payload => ipcRenderer.invoke('bridge:github-test', payload),
  syncGithubWorkspaceNow: () => ipcRenderer.invoke('bridge:github-sync-now'),
  onState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bridge:state', listener);
    return () => ipcRenderer.removeListener('bridge:state', listener);
  },
}));
