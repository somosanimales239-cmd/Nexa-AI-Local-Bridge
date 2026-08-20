'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'src/services/bridge-client.js'), 'utf8');
const executorSource = fs.readFileSync(path.join(root, 'src/services/read-only-executor.js'), 'utf8');
const { BridgePolicy } = require(path.join(root, 'src/services/policy.js'));
const { assertAllowedPath, executeReadOnlyCommand } = require(path.join(root, 'src/services/read-only-executor.js'));

test('complete-product npm validation contract is present', () => {
  for (const key of ['validate:delivery','validate:project','test','test:acceptance','test:implementation','ui:smoke']) {
    assert.equal(typeof packageJson.scripts?.[key], 'string', `missing npm script ${key}`);
    assert.ok(packageJson.scripts[key].trim().length > 0, `empty npm script ${key}`);
  }
  assert.equal(packageJson.build?.asar, true);
});

test('Windows delivery has installer, portable and zip targets', () => {
  const targets = (packageJson.build?.win?.target || []).map(item => typeof item === 'string' ? item : item.target);
  assert.ok(targets.includes('nsis'));
  assert.ok(targets.includes('portable'));
  assert.ok(targets.includes('zip'));
});

test('main and preload share real bridge IPC channels', () => {
  const channels = ['bridge:get-state','bridge:test','bridge:connect','bridge:disconnect','bridge:reconnect','bridge:update-preferences','bridge:unpair','bridge:open-logs'];
  for (const channel of channels) {
    assert.ok(mainSource.includes(channel), `main.js missing ${channel}`);
    assert.ok(preloadSource.includes(channel), `preload.js missing ${channel}`);
  }
});

test('Hostinger heartbeat and command queue are executable runtime paths', () => {
  for (const marker of ['sendHeartbeat','pollCommand','submitCommandResult','submitCommandError','submitCommandCancelled']) {
    assert.ok(mainSource.includes(marker), `main.js missing ${marker}`);
  }
  for (const marker of ["action: 'heartbeat'","action: 'poll'","action: 'result'","action: 'error'","action: 'cancelled'"]) {
    assert.ok(clientSource.includes(marker), `bridge-client.js missing ${marker}`);
  }
});

test('server policy blocks execution when bridge or emergency gates deny access', () => {
  const policy = new BridgePolicy();
  policy.applyServerState({
    bridge_enabled: true,
    emergency_stop: false,
    full_computer_mode: false,
    permissions: { read_files: true },
  });
  assert.equal(policy.canExecute('read_files'), true);
  policy.applyServerState({
    bridge_enabled: true,
    emergency_stop: true,
    full_computer_mode: true,
    permissions: { read_files: true },
  });
  assert.equal(policy.canExecute('read_files'), false);
});

test('Allowed Folders prevents a read outside the configured root', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-allowed-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-outside-'));
  const inside = path.join(tempRoot, 'inside.txt');
  const outside = path.join(outsideRoot, 'outside.txt');
  fs.writeFileSync(inside, 'inside', 'utf8');
  fs.writeFileSync(outside, 'outside', 'utf8');
  assert.equal(assertAllowedPath(inside, [tempRoot]), path.resolve(inside));
  assert.throws(() => assertAllowedPath(outside, [tempRoot]), /Blocked by local Allowed Folders policy/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

test('read_file executes through policy and returns real file contents', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-read-'));
  const file = path.join(tempRoot, 'sample.txt');
  fs.writeFileSync(file, 'NEXA_READ_ACCEPTED', 'utf8');
  const policy = new BridgePolicy();
  policy.applyServerState({
    bridge_enabled: true,
    emergency_stop: false,
    full_computer_mode: false,
    permissions: { read_files: true },
  });
  const result = await executeReadOnlyCommand(
    { uuid: 'test-1', capability: 'read_files', action: 'read_file', args: { path: file } },
    { policy, systemInfo: {}, allowedRoots: [tempRoot] }
  );
  assert.equal(result.content, 'NEXA_READ_ACCEPTED');
  assert.equal(result.truncated, false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('read-only executor does not expose arbitrary command execution actions', () => {
  for (const forbidden of ["'cmd'", "'powershell'", "'python'", "'write_file'", "'delete_file'"]) {
    assert.equal(executorSource.includes(forbidden), false, `read-only executor unexpectedly contains ${forbidden}`);
  }
});
