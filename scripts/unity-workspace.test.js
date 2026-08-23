'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {
  isUnityProject,
  scanProject,
  installUnityIntegration,
  workspaceUuid,
  BRIDGE_PLUGIN_VERSION,
}=require('../src/services/unity-workspace');
const {
  buildUnityDiagnostics,
  sanitizeEditorLog,
  isStrongCompileError,
  classifyServiceIssue,
}=require('../src/services/unity-diagnostics');
const {deriveWorkspaceEndpoint}=require('../src/services/workspace-client');

test('workspace endpoint is derived from the paired agent endpoint',()=>{
  assert.equal(deriveWorkspaceEndpoint('https://example.com/api/agent.php'),'https://example.com/api/workspace.php');
});

test('Unity project detection requires Assets and ProjectSettings',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-unity-'));
  fs.mkdirSync(path.join(root,'Assets'));
  assert.equal(isUnityProject(root),false);
  fs.mkdirSync(path.join(root,'ProjectSettings'));
  assert.equal(isUnityProject(root),true);
});

test('Unity scanner mirrors readable text and lists binary metadata',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-unity-'));
  fs.mkdirSync(path.join(root,'Assets'),{recursive:true});
  fs.mkdirSync(path.join(root,'ProjectSettings'),{recursive:true});
  fs.writeFileSync(path.join(root,'Assets','Player.cs'),'class Player {}');
  fs.writeFileSync(path.join(root,'Assets','Hero.prefab'),'%YAML prefab');
  fs.writeFileSync(path.join(root,'Assets','Texture.png'),Buffer.from([0,1,2,3]));
  fs.mkdirSync(path.join(root,'.nexa-bridge'),{recursive:true});
  fs.writeFileSync(path.join(root,'.nexa-bridge','request.json'),'{"capture_scene":true}');
  const {rows,stats}=await scanProject(root);
  const script=rows.find(r=>r.relative_path==='Assets/Player.cs');
  const image=rows.find(r=>r.relative_path==='Assets/Texture.png');
  assert.equal(script.is_text,true);
  assert.match(script.content_text,/class Player/);
  assert.equal(script.file_kind,'cs');
  assert.equal(image.is_text,false);
  assert.equal(image.content_text,null);
  assert.equal(image.file_kind,'image');
  assert.equal(stats.cs,1);
  assert.equal(stats.prefabs,1);
  assert.equal(rows.some(r=>r.relative_path.startsWith('.nexa-bridge/')),false);
});

test('Unity integration installs versioned plugin only inside an allowed root',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-unity-'));
  fs.mkdirSync(path.join(root,'Assets'),{recursive:true});
  fs.mkdirSync(path.join(root,'ProjectSettings'),{recursive:true});
  const result=await installUnityIntegration(root,[root]);
  const pluginFile=path.join(root,'Assets','Editor','NexaBridge','NexaUnityBridge.cs');
  assert.equal(result.ok,true);
  assert.equal(result.plugin_version,BRIDGE_PLUGIN_VERSION);
  assert.equal(fs.existsSync(pluginFile),true);
  assert.match(fs.readFileSync(pluginFile,'utf8'),/NEXA_BRIDGE_PLUGIN_VERSION = "1\.5\.0"/);
  assert.match(fs.readFileSync(pluginFile,'utf8'),/compilationStarted/);
});

test('workspace UUID is stable for the same project path',()=>{
  const root=path.resolve('D:/UnityProjects/NexaGame');
  assert.equal(workspaceUuid(root),workspaceUuid(root));
  assert.match(workspaceUuid(root),/^unity_[a-f0-9]{32}$/);
});

test('Unity diagnostics do not count Licensing 404 as compile errors',()=>{
  const log=[
    '[Licensing::Client] Error: Code 404 while processing request (status: Found 0 entitlement groups)',
    '[Licensing::Client] Error: Code 404 while processing request (status: Found 0 entitlement groups)',
    'Assets/Scripts/PlayerController.cs(42,13): error CS1002: ; expected',
  ].join('\n');

  const result=buildUnityDiagnostics([],log);
  assert.equal(result.compile_error_count,1);
  assert.equal(result.service_issue_count,1);
  assert.equal(result.licensing_issue_count,1);
  assert.equal(result.licensing_issue_occurrences,2);
  assert.equal(result.project_health,'compile_errors');
  assert.match(result.compile_errors[0].message,/CS1002/);
  assert.ok(!result.compile_errors.some(item=>/Licensing/i.test(item.message)));
});

test('Unity diagnostics deduplicate repeated real compiler errors',()=>{
  const line='Assets/Scripts/Fighter.cs(10,5): error CS0103: The name x does not exist';
  const result=buildUnityDiagnostics([],`${line}\n${line}\n${line}`);
  assert.equal(result.compile_error_count,1);
  assert.equal(result.compile_error_occurrences,3);
  assert.equal(result.compile_errors[0].occurrences,3);
});

test('plugin compiler errors remain authoritative compile diagnostics',()=>{
  const result=buildUnityDiagnostics([
    {message:'Assets/A.cs(1,1): error CS0103: name does not exist',code:'CS0103'}
  ],'');
  assert.equal(result.compile_error_count,1);
  assert.equal(result.compile_errors[0].code,'CS0103');
  assert.equal(result.compile_errors[0].source,'unity-plugin');
});

test('Unity log sanitizer redacts tokens, workspace keys and Windows username',()=>{
  const source=[
    '-accessToken abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    'https://example.test/workspace.php?k=ws_0123456789abcdef0123456789abcdef',
    'C:\\Users\\Samir\\AppData\\Local\\Unity\\Editor\\Editor.log',
  ].join('\n');

  const safe=sanitizeEditorLog(source);
  assert.doesNotMatch(safe,/abcdefghijklmnopqrstuvwxyz1234567890/);
  assert.match(safe,/\[REDACTED\]/);
  assert.match(safe,/\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(safe,/workspace\.php\?k=\[REDACTED\]/);
  assert.match(safe,/C:\\Users\\\[USER\]/);
});

test('strong compiler matcher is narrow enough to ignore generic service Error lines',()=>{
  assert.equal(isStrongCompileError('[Licensing::Client] Error: Code 404 while processing request'),false);
  assert.equal(isStrongCompileError('Assets/A.cs(1,2): error CS1002: ; expected'),true);
  assert.equal(classifyServiceIssue('[Licensing::Client] Error: Code 404 while processing request'),'unity_licensing');
});
