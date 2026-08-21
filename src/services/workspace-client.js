'use strict';

const { URL } = require('url');
const { validateEndpoint, postJson } = require('./bridge-client');

function deriveWorkspaceEndpoint(agentEndpoint) {
  const url = new URL(validateEndpoint(agentEndpoint));
  if (/\/agent\.php$/i.test(url.pathname)) url.pathname = url.pathname.replace(/agent\.php$/i, 'workspace.php');
  else url.pathname = url.pathname.replace(/\/$/, '') + '/workspace.php';
  return url.toString();
}

async function beginWorkspaceSync(endpoint, token, payload) {
  return postJson(endpoint, token, { action: 'begin_sync', ...payload }, 30000);
}
async function sendWorkspaceBatch(endpoint, token, payload) {
  return postJson(endpoint, token, { action: 'sync_batch', ...payload }, 45000);
}
async function finishWorkspaceSync(endpoint, token, payload) {
  return postJson(endpoint, token, { action: 'finish_sync', ...payload }, 30000);
}
async function uploadWorkspaceArtifact(endpoint, token, payload) {
  return postJson(endpoint, token, { action: 'upload_artifact', ...payload }, 60000);
}

module.exports = { deriveWorkspaceEndpoint, beginWorkspaceSync, sendWorkspaceBatch, finishWorkspaceSync, uploadWorkspaceArtifact };
