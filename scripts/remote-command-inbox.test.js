'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {
  parseEmail,
  verifyDkimSignatures,
  buildCommandEmailBody,
  extractCommandEnvelope,
  validateCommandEnvelope,
  RemoteCommandInbox,
  sanitizeResultForMirror,
  normalizeEmail,
}=require('../src/services/remote-command-inbox');



test('email normalization uses parser-compatible matching for normal and display-name addresses',()=>{
  assert.equal(normalizeEmail('Nexa Sender <Sender+unity@example.com>'),'sender+unity@example.com');
  assert.equal(normalizeEmail('plain.user@example.com'),'plain.user@example.com');
});

test('remote command envelope survives gzip+base64 email body encoding',()=>{
  const envelope={schema_version:1,channel_id:'channel_1234567890',challenge:'challenge_1234567890',command_id:'cmd_12345678',issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),actions:[{action:'write_text_file',args:{path:'D:/Game/A.cs',content:'hello'}}]};
  const body=buildCommandEmailBody(envelope);
  assert.match(body,/BEGIN NEXA COMMAND V1/);
  assert.deepEqual(extractCommandEnvelope(body),envelope);
});

test('email parser extracts multipart text, sender and authentication evidence',()=>{
  const raw=[
    'From: Nexa Sender <sender@example.com>',
    'Subject: [NEXA-CMD] test',
    'Authentication-Results: mx.example; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com',
    'Content-Type: multipart/alternative; boundary="abc"',
    '',
    '--abc',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'hello=20world',
    '--abc',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>html</p>',
    '--abc--',
  ].join('\r\n');
  const parsed=parseEmail(raw);
  assert.equal(parsed.from,'sender@example.com');
  assert.equal(parsed.subject,'[NEXA-CMD] test');
  assert.equal(parsed.authenticatedSender,true);
  assert.match(parsed.text,/hello world/);
});

test('command validation enforces channel challenge, expiry and replay-ready id format',()=>{
  const now=Date.now();
  const channel={channel_id:'channel_1234567890',challenge:'challenge_1234567890'};
  const base={schema_version:1,channel_id:channel.channel_id,challenge:channel.challenge,command_id:'cmd_12345678',issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),actions:[{action:'read_file',args:{path:'x'}}]};
  assert.equal(validateCommandEnvelope(base,channel,now).command_id,'cmd_12345678');
  assert.throws(()=>validateCommandEnvelope({...base,challenge:'wrong'},channel,now),/challenge/i);
  assert.throws(()=>validateCommandEnvelope({...base,expires_at:new Date(now-1).toISOString()},channel,now),/expired/i);
  assert.throws(()=>validateCommandEnvelope({...base,actions:[]},channel,now),/1-50 actions/i);
});

test('remote inbox channel rotates challenges and persists replay state locally',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-inbox-'));
  const inbox=new RemoteCommandInbox({userDataPath:root,logger:null});
  const first=inbox.channel.challenge;
  inbox.rotateChallenge();
  assert.notEqual(inbox.channel.challenge,first);
  const second=new RemoteCommandInbox({userDataPath:root,logger:null});
  assert.equal(second.channel.challenge,inbox.channel.challenge);
  assert.match(second.channel.channel_id,/^channel_/);
});

test('remote status publication never contains mailbox credentials and publishes challenge only',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-project-'));
  fs.mkdirSync(path.join(root,'Assets'));
  fs.mkdirSync(path.join(root,'ProjectSettings'));
  const userData=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-inbox-'));
  const inbox=new RemoteCommandInbox({userDataPath:userData,logger:null});
  const status=inbox.getPublicStatus({enabled:true,configured:true,pollSeconds:15,policy:{bridgeEnabled:true,emergencyStop:false,fullComputerMode:false,permissions:{write_files:true}}});
  inbox.writeProjectStatus([root],status,{command_id:'cmd_test123',status:'completed'});
  const text=fs.readFileSync(path.join(root,'.nexa-bridge','remote-channel.json'),'utf8');
  assert.match(text,/challenge_/);
  assert.doesNotMatch(text,/password|remoteInboxUsername|allowedSender/i);
});

test('mirrored command results redact secret fields and omit full file content',()=>{
  const safe=sanitizeResultForMirror({content:'secret file body',token:'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',stdout:'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'});
  assert.match(String(safe.content),/CONTENT_OMITTED/);
  assert.equal(safe.token,'[REDACTED_FIELD]');
  assert.doesNotMatch(safe.stdout,/abcdefghijklmnopqrstuvwxyz/);
});


test('cryptographic DKIM verification accepts RFC 6376 header oversigning used by Gmail', async()=>{
  const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:1024});
  const body='hello from nexa\r\n';
  const bodyHash=crypto.createHash('sha256').update(Buffer.from(body,'utf8')).digest('base64');
  const h='from:to:subject:from';
  const dkimValueWithoutSignature=` v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=nexa; h=${h}; bh=${bodyHash}; b=`;
  const signedData=[
    'from:sender@example.com\r\n',
    'to:receiver@example.net\r\n',
    'subject:Nexa oversign test\r\n',
    `dkim-signature:${dkimValueWithoutSignature.trim().replace(/[ \t]+/g,' ')}`,
  ].join('');
  const signature=crypto.sign('RSA-SHA256',Buffer.from(signedData,'utf8'),privateKey).toString('base64');
  const raw=[
    'From: sender@example.com',
    'To: receiver@example.net',
    'Subject: Nexa oversign test',
    `DKIM-Signature:${dkimValueWithoutSignature}${signature}`,
    '',
    'hello from nexa',
    '',
  ].join('\r\n');
  const der=publicKey.export({format:'der',type:'spki'}).toString('base64');
  const result=await verifyDkimSignatures(raw,'sender@example.com',{resolveTxt:async()=>[[`v=DKIM1; k=rsa; p=${der}`]]});
  assert.equal(result.ok,true,result.error||'DKIM verification should pass');
  assert.equal(result.domain,'example.com');
});
