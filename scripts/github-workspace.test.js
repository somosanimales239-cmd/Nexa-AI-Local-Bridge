'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateRepo,validateBranch,workspacePrefix,isWritableRemotePath}=require('../src/services/github-workspace');

test('GitHub repository validation accepts owner/repository only',()=>{
  assert.equal(validateRepo('somosanimales239-cmd/Nexa-AI-Local-Bridge'),'somosanimales239-cmd/Nexa-AI-Local-Bridge');
  assert.throws(()=>validateRepo('https://github.com/a/b'),/owner\/repository/);
});

test('workspace branch validation blocks invalid refs',()=>{
  assert.equal(validateBranch('nexa-unity-workspace'),'nexa-unity-workspace');
  assert.equal(validateBranch('nexa/workspace'),'nexa/workspace');
  assert.throws(()=>validateBranch('../main'),/valid GitHub branch/);
  assert.throws(()=>validateBranch('bad branch'),/valid GitHub branch/);
});

test('workspace prefix is stable and project-specific',()=>{
  const p=workspacePrefix({name:'Animal Gladiators',workspace_uuid:'unity_1234567890abcdef1234567890abcdef'});
  assert.equal(p,'unity-workspaces/Animal-Gladiators-90abcdef');
});

test('remote write-back allows Unity text formats but blocks generated and binary paths',()=>{
  for(const good of ['Assets/Scripts/Player.cs','Assets/Scenes/Arena.unity','Assets/Wolf.prefab','Assets/Mat/Wolf.mat','ProjectSettings/TagManager.asset','Packages/manifest.json']) assert.equal(isWritableRemotePath(good),true,good);
  for(const bad of ['__NEXA__/unity-status.json','.nexa-bridge/request.json','Library/state.asset','Assets/Wolf.fbx','Assets/Texture.png','../outside.cs']) assert.equal(isWritableRemotePath(bad),false,bad);
});
