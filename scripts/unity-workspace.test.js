'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {isUnityProject,scanProject,installUnityIntegration,workspaceUuid}=require('../src/services/unity-workspace');
const {deriveWorkspaceEndpoint}=require('../src/services/workspace-client');

test('workspace endpoint is derived from the paired agent endpoint',()=>{
  assert.equal(deriveWorkspaceEndpoint('https://example.com/api/agent.php'),'https://example.com/api/workspace.php');
});

test('Unity project detection requires Assets and ProjectSettings',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-unity-'));
  fs.mkdirSync(path.join(root,'Assets')); assert.equal(isUnityProject(root),false);
  fs.mkdirSync(path.join(root,'ProjectSettings')); assert.equal(isUnityProject(root),true);
});

test('Unity scanner mirrors readable text and lists binary metadata',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-unity-'));
  fs.mkdirSync(path.join(root,'Assets'),{recursive:true}); fs.mkdirSync(path.join(root,'ProjectSettings'),{recursive:true});
  fs.writeFileSync(path.join(root,'Assets','Player.cs'),'class Player {}');
  fs.writeFileSync(path.join(root,'Assets','Hero.prefab'),'%YAML prefab');
  fs.writeFileSync(path.join(root,'Assets','Texture.png'),Buffer.from([0,1,2,3]));
  const {rows,stats}=await scanProject(root);
  const script=rows.find(r=>r.relative_path==='Assets/Player.cs');
  const image=rows.find(r=>r.relative_path==='Assets/Texture.png');
  assert.equal(script.is_text,true); assert.match(script.content_text,/class Player/); assert.equal(script.file_kind,'cs');
  assert.equal(image.is_text,false); assert.equal(image.content_text,null); assert.equal(image.file_kind,'image');
  assert.equal(stats.cs,1); assert.equal(stats.prefabs,1);
});

test('Unity integration installs only inside an allowed root',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexa-unity-'));
  fs.mkdirSync(path.join(root,'Assets'),{recursive:true}); fs.mkdirSync(path.join(root,'ProjectSettings'),{recursive:true});
  const result=await installUnityIntegration(root,[root]);
  assert.equal(result.ok,true); assert.equal(fs.existsSync(path.join(root,'Assets','Editor','NexaBridge','NexaUnityBridge.cs')),true);
});

test('workspace UUID is stable for the same project path',()=>{
  const root=path.resolve('D:/UnityProjects/NexaGame');
  assert.equal(workspaceUuid(root),workspaceUuid(root));
  assert.match(workspaceUuid(root),/^unity_[a-f0-9]{32}$/);
});
