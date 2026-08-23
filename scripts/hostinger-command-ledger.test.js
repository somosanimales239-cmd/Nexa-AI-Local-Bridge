'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HostingerCommandLedger } = require('../src/services/hostinger-command-ledger');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-ledger-'));
  return { root, ledger: new HostingerCommandLedger({ file:path.join(root,'ledger.json') }) };
}

const command = { uuid:'cmd_ledger_test', action:'write_text_file', capability:'write_files', args:{ path:'D:/safe/test.txt', content:'ok' } };

test('new command becomes durable inflight before execution', () => {
  const { root, ledger } = fixture();
  try {
    const first = ledger.begin(command);
    assert.equal(first.mode, 'execute');
    const second = ledger.inspect(command);
    assert.equal(second.mode, 'uncertain');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('final result is replayed instead of re-executed', () => {
  const { root, ledger } = fixture();
  try {
    ledger.begin(command);
    ledger.finish(command, 'result', { ok:true, changed_files:['D:/safe/test.txt'] });
    const decision = ledger.begin(command);
    assert.equal(decision.mode, 'replay');
    assert.equal(decision.entry.final_kind, 'result');
    assert.deepEqual(decision.entry.payload.changed_files, ['D:/safe/test.txt']);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('reused UUID with changed command content is rejected', () => {
  const { root, ledger } = fixture();
  try {
    ledger.begin(command);
    ledger.finish(command, 'result', { ok:true });
    const changed = { ...command, args:{ ...command.args, content:'different' } };
    assert.equal(ledger.begin(changed).mode, 'conflict');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
