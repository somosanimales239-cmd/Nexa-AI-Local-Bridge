'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const secureConfig = fs.readFileSync(path.join(root, 'src/services/secure-config.js'), 'utf8');

test('pairing user flow is visible and wired to runtime actions', () => {
  for (const label of ['Agent Endpoint','Pairing Token','Device Label','Test Connection','Connect']) {
    assert.match(html, new RegExp(label, 'i'));
  }
  assert.match(renderer, /testConnection/);
  assert.match(renderer, /\.connect\(/);
  assert.match(main, /bridge:test/);
  assert.match(main, /bridge:connect/);
});

test('local security user flow exposes Allowed Folders and Start with Windows', () => {
  assert.match(html, /Allowed Folders/i);
  assert.match(html, /Start with Windows/i);
  assert.match(renderer, /allowedRoots/);
  assert.match(renderer, /startWithWindows/);
  assert.match(main, /app\.setLoginItemSettings/);
});

test('remote policy user flow exposes emergency stop and permissions', () => {
  assert.match(html, /Emergency Stop/i);
  assert.match(renderer, /Read Files/i);
  assert.match(renderer, /PowerShell/i);
  assert.match(renderer, /Screenshots/i);
  assert.match(main, /applyPolicy/);
});

test('pairing token is encrypted outside renderer storage', () => {
  assert.doesNotMatch(renderer, /localStorage/);
  assert.match(secureConfig, /safeStorage\.encryptString/);
  assert.match(secureConfig, /safeStorage\.decryptString/);
});

test('installed application closes to tray while paired and can quit explicitly', () => {
  assert.match(main, /mainWindow\.hide\(\)/);
  assert.match(main, /new Tray\(/);
  assert.match(main, /label: 'Quit'/);
});

test('remote command activity is visible in the interface', () => {
  assert.match(html, /Current Hostinger command/i);
  assert.match(renderer, /currentCommand/);
  assert.match(renderer, /queueBadge/);
  assert.match(renderer, /No remote command is running/i);
});

test('GitHub Remote Workspace user flow is visible and wired', () => {
  assert.match(html, /GitHub Remote Workspace/i);
  assert.match(html, /Apply ChatGPT edits back to Unity/i);
  assert.match(renderer, /saveGithubWorkspace/);
  assert.match(renderer, /syncGithubWorkspaceNow/);
  assert.match(main, /bridge:github-sync-now/);
});

test('Unity workspace continues syncing valid projects when another configured path is bad', () => {
  assert.match(main, /failedResults/);
  assert.match(main, /successfulRoots/);
  assert.match(main, /Skipped .*invalid\/unavailable path/);
  assert.match(main, /roots:\s*successfulRoots/);
});

test('Unity workspace UI separates real compile errors from Unity service issues', () => {
  assert.match(renderer, /real compile error/);
  assert.match(renderer, /Unity service issue/);
  assert.match(renderer, /Unity integration update required/);
});

