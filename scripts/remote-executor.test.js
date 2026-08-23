'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const { executeRemoteEnvelope, ACTION_CAPABILITIES }=require('../src/services/remote-executor');
const { assertAllowedPath }=require('../src/services/read-only-executor');

function policy(allowed={}){
  return {
    fullComputerMode:allowed.fullComputerMode===true,
    canExecute:name=>allowed[name]===true,
  };
}
function ctx(root,allowed){return{policy:policy(allowed),systemInfo:{},allowedRoots:[root],unityRoots:[],userDataPath:fs.mkdtempSync(path.join(os.tmpdir(),'nexa-user-'))};}

test('remote executor maps every mutation/command action to an explicit Hostinger capability',()=>{
  assert.equal(ACTION_CAPABILITIES.write_text_file,'write_files');
  assert.equal(ACTION_CAPABILITIES.run_powershell,'powershell');
  assert.equal(ACTION_CAPABILITIES.run_python,'python');
  assert.equal(ACTION_CAPABILITIES.run_git,'git');
  assert.equal(ACTION_CAPABILITIES.download_file,'browser');
  assert.equal(ACTION_CAPABILITIES.unity_editor_job,'write_files');
});

test('transactional text writes complete as one remote batch',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-exec-'));
  const a=path.join(root,'A.txt'); const b=path.join(root,'B.txt');
  const result=await executeRemoteEnvelope({command_id:'cmd_batch123',actions:[
    {action:'write_text_file',args:{path:a,content:'alpha'}},
    {action:'write_text_file',args:{path:b,content:'beta'}},
  ],options:{rollback_on_error:true}},ctx(root,{write_files:true}));
  assert.equal(result.ok,true);
  assert.equal(fs.readFileSync(a,'utf8'),'alpha');
  assert.equal(fs.readFileSync(b,'utf8'),'beta');
  assert.equal(result.changed_files.length,2);
});

test('failed multi-action batch rolls earlier file changes back automatically',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-exec-'));
  const file=path.join(root,'A.txt'); fs.writeFileSync(file,'original');
  const result=await executeRemoteEnvelope({command_id:'cmd_rollback123',actions:[
    {action:'write_text_file',args:{path:file,content:'changed'}},
    {action:'write_text_file',args:{path:path.join(root,'B.txt'),content:'will rollback'}},
    {action:'totally_unknown_action',args:{}},
  ],options:{rollback_on_error:true}},ctx(root,{write_files:true}));
  assert.equal(result.ok,false);
  assert.equal(result.rollback.performed,true);
  assert.equal(fs.readFileSync(file,'utf8'),'original');
  assert.equal(fs.existsSync(path.join(root,'B.txt')),false);
});

test('write action is blocked when Hostinger Write Files permission is off',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-exec-'));
  const file=path.join(root,'A.txt');
  const result=await executeRemoteEnvelope({command_id:'cmd_blocked123',actions:[{action:'write_text_file',args:{path:file,content:'x'}}],options:{}},ctx(root,{write_files:false}));
  assert.equal(result.ok,false);
  assert.match(result.error,/write_files/i);
  assert.equal(fs.existsSync(file),false);
});

test('deleting the Allowed Folder root itself is blocked even with Write Files enabled',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-exec-'));
  const result=await executeRemoteEnvelope({command_id:'cmd_rootdelete123',actions:[{action:'delete_path',args:{path:root,recursive:true}}],options:{}},ctx(root,{write_files:true}));
  assert.equal(result.ok,false);
  assert.match(result.error,/Allowed Folder root/i);
  assert.equal(fs.existsSync(root),true);
});

test('junction/symlink escape is blocked by Allowed Folders canonical-path protection',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-root-'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-outside-'));
  const link=path.join(root,'link');
  try{fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');}
  catch{return;}
  assert.throws(()=>assertAllowedPath(path.join(link,'escape.txt'),[root]),/resolves outside Allowed Folders/i);
});

test('SHA precondition protects against overwriting a concurrently changed file',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-exec-'));
  const file=path.join(root,'A.txt'); fs.writeFileSync(file,'current');
  const result=await executeRemoteEnvelope({command_id:'cmd_hash12345',actions:[{action:'write_text_file',args:{path:file,content:'new',expected_sha256:'0000'}}],options:{}},ctx(root,{write_files:true}));
  assert.equal(result.ok,false);
  assert.match(result.error,/SHA-256/i);
  assert.equal(fs.readFileSync(file,'utf8'),'current');
});
