'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const { URL } = require('url');
const { assertAllowedPath } = require('./read-only-executor');
const { buildUnityMirrorSnapshot } = require('./unity-workspace');

const API = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const WRITABLE_EXTENSIONS = new Set([
  '.cs','.unity','.prefab','.shader','.shadergraph','.mat','.json','.asmdef','.asmref','.xml','.yaml','.yml',
  '.txt','.md','.cginc','.hlsl','.compute','.uss','.uxml','.inputactions','.controller','.anim','.asset','.rsp','.props'
]);
const NEVER_WRITE_PREFIXES = ['__nexa__/','.nexa-bridge/','library/','temp/','obj/','.git/','.vs/'];

function sha256Buffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256Text(value) { return sha256Buffer(Buffer.from(String(value ?? ''), 'utf8')); }
function slash(value) { return String(value || '').replace(/\\/g, '/'); }
function safeSegment(value) {
  const cleaned = String(value || 'UnityProject').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'UnityProject';
}
function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GitHub repository must use owner/repository format.');
  return repo;
}
function validateBranch(value) {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 180 || branch.startsWith('/') || branch.endsWith('/') || branch.includes('..') || /[~^:?*\[\\\s]/.test(branch)) {
    throw new Error('Enter a valid GitHub branch name.');
  }
  return branch;
}
function encodeRefBranch(branch) { return validateBranch(branch).split('/').map(encodeURIComponent).join('/'); }
function workspacePrefix(snapshot) {
  return `unity-workspaces/${safeSegment(snapshot.name)}-${snapshot.workspace_uuid.slice(-8)}`;
}
function isWritableRemotePath(relativePath) {
  const rel = slash(relativePath).replace(/^\/+/, '');
  if (!rel || rel.includes('../') || rel.startsWith('../')) return false;
  const low = rel.toLowerCase();
  if (NEVER_WRITE_PREFIXES.some(prefix => low.startsWith(prefix))) return false;
  const ext = path.posix.extname(rel).toLowerCase();
  return WRITABLE_EXTENSIONS.has(ext);
}
function quoteCurlConfigValue(value) {
  return `"${String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')}"`;
}
function shouldCurlFallback(error) {
  if (process.platform !== 'win32') return false;
  const code = String(error?.code || '').toUpperCase();
  return ['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT','ESOCKETTIMEDOUT','NEXA_TIMEOUT'].includes(code);
}

function requestNode(method, urlValue, token, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve,reject) => {
    const url = new URL(urlValue);
    const payload = body === undefined || body === null ? '' : JSON.stringify(body);
    let settled = false;
    const req = https.request({
      protocol:'https:', hostname:url.hostname, port:443, path:`${url.pathname}${url.search}`, method,
      agent:false, servername:url.hostname, ALPNProtocols:['http/1.1'], minVersion:'TLSv1.2', autoSelectFamily:true, autoSelectFamilyAttemptTimeout:250,
      headers:{
        'Authorization':`Bearer ${token}`,
        'Accept':'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        'User-Agent':'Nexa-AI-Local-Bridge/1.6.2',
        'Connection':'close',
        ...(payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {})
      }
    }, res => {
      const chunks=[]; let bytes=0;
      res.on('data',chunk=>{ bytes+=chunk.length; if(bytes>MAX_RESPONSE_BYTES){ const e=new Error('GitHub response exceeded safe size limit.'); e.code='RESPONSE_TOO_LARGE'; req.destroy(e); return; } chunks.push(chunk); });
      res.on('end',()=>{ if(settled)return; settled=true; resolve({status:Number(res.statusCode||0),text:Buffer.concat(chunks).toString('utf8'),headers:res.headers||{}}); });
      res.on('error',reject);
    });
    req.setTimeout(timeoutMs,()=>{ const e=new Error(`Timed out after ${timeoutMs} ms`); e.code='NEXA_TIMEOUT'; req.destroy(e); });
    req.on('error',e=>{ if(settled)return; settled=true; reject(e); });
    req.end(payload);
  });
}

function requestCurl(method, urlValue, token, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve,reject)=>{
    const maxSeconds=Math.max(5,Math.ceil(timeoutMs/1000));
    const marker='NEXA_GITHUB_HTTP_STATUS:';
    const payload=body===undefined||body===null?'':JSON.stringify(body);
    const config=[
      `url = ${quoteCurlConfigValue(urlValue)}`,
      `request = ${quoteCurlConfigValue(method)}`,
      'http1.1','silent','show-error','location','max-redirs = 3',
      `connect-timeout = ${Math.min(10,maxSeconds)}`,`max-time = ${maxSeconds}`,
      `header = ${quoteCurlConfigValue(`Authorization: Bearer ${token}`)}`,
      `header = ${quoteCurlConfigValue('Accept: application/vnd.github+json')}`,
      `header = ${quoteCurlConfigValue('X-GitHub-Api-Version: 2022-11-28')}`,
      `header = ${quoteCurlConfigValue('User-Agent: Nexa-AI-Local-Bridge/1.6.2')}`,
      ...(payload ? [`header = ${quoteCurlConfigValue('Content-Type: application/json')}`,`data-binary = ${quoteCurlConfigValue(payload)}`] : []),
      `write-out = ${quoteCurlConfigValue(`\\n${marker}%{http_code}`)}`,''] .join('\n');
    const child=spawn('curl.exe',['--config','-'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[]; let bytes=0,settled=false;
    const timer=setTimeout(()=>{ try{child.kill();}catch{} const e=new Error('GitHub curl request timed out.'); e.code='NEXA_TIMEOUT'; if(!settled){settled=true;reject(e);} },timeoutMs+2500);
    child.stdout.on('data',c=>{ bytes+=c.length; if(bytes>MAX_RESPONSE_BYTES+8192){try{child.kill();}catch{} const e=new Error('GitHub response exceeded safe size limit.');e.code='RESPONSE_TOO_LARGE';if(!settled){settled=true;reject(e);}return;} stdout.push(c); });
    child.stderr.on('data',c=>stderr.push(c));
    child.on('error',e=>{clearTimeout(timer);if(!settled){settled=true;reject(e);}});
    child.on('close',code=>{clearTimeout(timer);if(settled)return;const out=Buffer.concat(stdout).toString('utf8');const idx=out.lastIndexOf(`\n${marker}`);if(idx<0){const e=new Error(Buffer.concat(stderr).toString('utf8').trim()||`curl.exe exited with code ${code}`);e.code=code===6?'ENOTFOUND':code===28?'NEXA_TIMEOUT':'CURL_ERROR';settled=true;reject(e);return;} settled=true;resolve({status:Number(out.slice(idx+1+marker.length).trim()),text:out.slice(0,idx),headers:{},transport:'windows-curl'});});
    child.stdin.on('error',()=>{}); child.stdin.end(config);
  });
}

async function request(method, apiPath, token, body, timeoutMs=DEFAULT_TIMEOUT_MS) {
  const url = apiPath.startsWith('https://') ? apiPath : `${API}${apiPath}`;
  try { return await requestNode(method,url,token,body,Math.min(timeoutMs,15000)); }
  catch(error){ if(!shouldCurlFallback(error)) throw error; return requestCurl(method,url,token,body,timeoutMs); }
}

async function api(method, apiPath, token, body, {allow404=false,timeoutMs=DEFAULT_TIMEOUT_MS}={}) {
  const response=await request(method,apiPath,token,body,timeoutMs);
  let data=null; if(response.text){ try{data=JSON.parse(response.text);}catch{} }
  if(response.status===404 && allow404) return null;
  if(response.status===401 || response.status===403){ const e=new Error('GitHub token was rejected or does not have Contents read/write permission for this repository.'); e.code='GITHUB_AUTH'; throw e; }
  if(response.status<200 || response.status>=300){ const detail=data?.message?` ${data.message}`:''; const e=new Error(`GitHub returned HTTP ${response.status}.${detail}`.trim()); e.code='GITHUB_HTTP'; throw e; }
  return data;
}

async function testGithubConnection({repo,token}) {
  repo=validateRepo(repo); if(!token) throw new Error('Enter a GitHub fine-grained token.');
  const data=await api('GET',`/repos/${repo}`,token,null);
  return {ok:true,repository:data?.full_name||repo,default_branch:data?.default_branch||'main',private:data?.private===true};
}
async function getRef(repo,branch,token,allow404=false){ return api('GET',`/repos/${repo}/git/ref/heads/${encodeRefBranch(branch)}`,token,null,{allow404}); }
async function ensureBranch(repo,branch,token,baseBranch='main') {
  repo=validateRepo(repo); branch=validateBranch(branch); baseBranch=validateBranch(baseBranch);
  const existing=await getRef(repo,branch,token,true); if(existing?.object?.sha) return {sha:existing.object.sha,created:false};
  const base=await getRef(repo,baseBranch,token,false); const sha=base?.object?.sha; if(!sha) throw new Error(`Could not resolve GitHub base branch ${baseBranch}.`);
  await api('POST',`/repos/${repo}/git/refs`,token,{ref:`refs/heads/${branch}`,sha});
  return {sha,created:true};
}
async function commitTreeSha(repo,commitSha,token){ const c=await api('GET',`/repos/${repo}/git/commits/${encodeURIComponent(commitSha)}`,token,null); return c?.tree?.sha||''; }
async function treeMap(repo,commitSha,token){ const treeSha=await commitTreeSha(repo,commitSha,token); if(!treeSha)return{}; const data=await api('GET',`/repos/${repo}/git/trees/${treeSha}?recursive=1`,token,null,{timeoutMs:45000}); const out={}; for(const row of data?.tree||[]){ if(row.type==='blob'&&typeof row.path==='string'&&typeof row.sha==='string') out[row.path]=row.sha; } return out; }
async function fetchBlobText(repo,blobSha,token){ const data=await api('GET',`/repos/${repo}/git/blobs/${encodeURIComponent(blobSha)}`,token,null); if(data?.encoding!=='base64'||typeof data?.content!=='string')throw new Error('GitHub blob response was invalid.'); return Buffer.from(data.content.replace(/\n/g,''),'base64').toString('utf8'); }
async function createBlob(repo,token,content,encoding='utf-8'){ const data=await api('POST',`/repos/${repo}/git/blobs`,token,{content,encoding}); if(!data?.sha)throw new Error('GitHub did not return a blob SHA.'); return data.sha; }
async function mapLimit(items,limit,fn){ const out=new Array(items.length); let cursor=0; async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i],i);}} await Promise.all(Array.from({length:Math.min(limit,items.length||1)},worker));return out; }
function readState(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return{version:1,targets:{}};}}
function writeState(file,state){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`${JSON.stringify(state,null,2)}\n`,{encoding:'utf8',mode:0o600});}
function stateKey(repo,branch){return `${repo}#${branch}`;}
function fileHashIfExists(file){try{const st=fs.statSync(file);if(!st.isFile())return'';return sha256Buffer(fs.readFileSync(file));}catch{return'';}}
function safeLocalFile(root,relativePath,allowedRoots){ const normalized=slash(relativePath).replace(/^\/+/, ''); if(!isWritableRemotePath(normalized))throw new Error('Remote path is not writable by Unity workspace policy.'); const destination=path.resolve(root,...normalized.split('/')); assertAllowedPath(destination,allowedRoots); const rootResolved=path.resolve(root); const rel=path.relative(rootResolved,destination); if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Remote path escaped the Unity project root.'); return destination; }

async function applyRemoteChanges({snapshots,repo,branch,token,remoteTree,baseline,allowedRoots,enabled}) {
  const results=[]; if(!enabled || !baseline?.workspaces) return results;
  for(const snap of snapshots){
    const prefix=workspacePrefix(snap); const baseWs=baseline.workspaces[snap.workspace_uuid]; if(!baseWs)continue;
    let applied=0,conflicts=0,ignored=0;
    const projectPrefix=`${prefix}/project/`;
    for(const [gitPath,remoteSha] of Object.entries(remoteTree)){
      if(!gitPath.startsWith(projectPrefix))continue;
      const rel=gitPath.slice(projectPrefix.length); if(!isWritableRemotePath(rel)){ignored++;continue;}
      const previousSha=baseWs.remoteBlobs?.[gitPath]||''; if(previousSha===remoteSha)continue;
      const previousLocalHash=baseWs.localHashes?.[rel]||'';
      let destination; try{destination=safeLocalFile(snap.root,rel,allowedRoots);}catch{ignored++;continue;}
      const currentLocalHash=fileHashIfExists(destination);
      const safeToApply=(previousLocalHash&&currentLocalHash===previousLocalHash)||(!previousLocalHash&&!currentLocalHash);
      if(!safeToApply){conflicts++;continue;}
      const text=await fetchBlobText(repo,remoteSha,token);
      if(Buffer.byteLength(text,'utf8')>1024*1024){ignored++;continue;}
      fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.writeFileSync(destination,text,'utf8'); applied++;
    }
    results.push({name:snap.name,applied,conflicts,ignored});
  }
  return results;
}

function generatedFiles(snapshot,binaryRows){
  const prefix=workspacePrefix(snapshot); const files=[];
  const status=JSON.stringify(snapshot.status,null,2)+'\n';
  const manifest=JSON.stringify({workspace_uuid:snapshot.workspace_uuid,name:snapshot.name,project_version:snapshot.project_version,stats:snapshot.stats,generated_at:new Date().toISOString()},null,2)+'\n';
  const binary=JSON.stringify(binaryRows.map(r=>({path:r.relative_path,kind:r.file_kind,extension:r.extension,size_bytes:r.size_bytes,modified_at:r.modified_at})),null,2)+'\n';
  files.push({path:`${prefix}/__NEXA__/unity-status.json`,content:status,hash:sha256Text(status)});
  files.push({path:`${prefix}/__NEXA__/workspace-manifest.json`,content:manifest,hash:sha256Text(manifest)});
  files.push({path:`${prefix}/__NEXA__/binary-index.json`,content:binary,hash:sha256Text(binary)});
  return files;
}

async function publishGithubWorkspaces({roots,allowedRoots,repo,branch,token,stateFile,applyRemote=false,writePermission=false,screenshotPermission=false}) {
  repo=validateRepo(repo); branch=validateBranch(branch); if(!token)throw new Error('GitHub token is not configured.');
  const repoInfo=await testGithubConnection({repo,token});
  const baseBranch=validateBranch(repoInfo.default_branch||'main');
  const ensured=await ensureBranch(repo,branch,token,baseBranch);
  const headRef=await getRef(repo,branch,token,false); const remoteHead=headRef?.object?.sha||ensured.sha;
  const remoteTree=remoteHead?await treeMap(repo,remoteHead,token):{};
  const state=readState(stateFile); const key=stateKey(repo,branch); const baseline=state.targets?.[key]||null;

  let snapshots=[];
  for(const root of roots) snapshots.push(await buildUnityMirrorSnapshot({root,allowedRoots}));
  const pullResults=await applyRemoteChanges({snapshots,repo,branch,token,remoteTree,baseline,allowedRoots,enabled:applyRemote&&writePermission});
  if(pullResults.some(r=>r.applied>0)){
    snapshots=[]; for(const root of roots) snapshots.push(await buildUnityMirrorSnapshot({root,allowedRoots}));
  }

  const desired=[]; const workspaceStates={};
  const readme=`# Nexa Remote Unity Workspace\n\nThis branch is a machine-generated snapshot from Nexa AI Local Bridge 1.6.2.\n\n- Edit text files only under \`unity-workspaces/*/project/\` when you want the Windows Bridge to apply a change back to Unity.\n- Generated status, logs and visual metadata live under \`__NEXA__\`.\n- Remote deletes are intentionally not applied to the PC.\n- Local conflicts are never overwritten automatically.\n`;
  desired.push({path:'README.md',content:readme,hash:sha256Text(readme)});

  for(const snap of snapshots){
    const prefix=workspacePrefix(snap); const textRows=snap.rows.filter(r=>r.is_text&&typeof r.content_text==='string'); const binaryRows=snap.rows.filter(r=>!r.is_text||typeof r.content_text!=='string');
    const localHashes={};
    for(const row of textRows){
      const rel=slash(row.relative_path); const content=row.content_text; const hash=row.sha256||sha256Text(content);
      if(rel.toUpperCase().startsWith('__NEXA__/')) desired.push({path:`${prefix}/${rel}`,content,hash});
      else { localHashes[rel]=hash; desired.push({path:`${prefix}/project/${rel}`,content,hash}); }
    }
    for(const g of generatedFiles(snap,binaryRows))desired.push(g);
    if(screenshotPermission){
      for(const [kind,name] of [['scene-view','scene-view.png'],['game-view','game-view.png']]){
        const file=path.join(snap.root,'.nexa-bridge',name); if(!fs.existsSync(file))continue; const data=fs.readFileSync(file); if(!data.length||data.length>6*1024*1024)continue;
        desired.push({path:`${prefix}/__NEXA__/${name}`,binary:data,hash:sha256Buffer(data),kind});
      }
    }
    workspaceStates[snap.workspace_uuid]={name:snap.name,prefix,localHashes,remoteBlobs:{}};
  }

  const previous=baseline?.entries||{};
  const blobRows=await mapLimit(desired,6,async item=>{
    const prev=previous[item.path]; if(prev&&prev.hash===item.hash&&prev.sha)return{...item,sha:prev.sha};
    const sha=item.binary?await createBlob(repo,token,item.binary.toString('base64'),'base64'):await createBlob(repo,token,item.content,'utf-8'); return{...item,sha};
  });
  const treePayload=blobRows.map(item=>({path:item.path,mode:'100644',type:'blob',sha:item.sha}));
  const tree=await api('POST',`/repos/${repo}/git/trees`,token,{tree:treePayload},{timeoutMs:60000}); if(!tree?.sha)throw new Error('GitHub did not return a tree SHA.');
  const baseRef=await getRef(repo,baseBranch,token,false); const baseSha=baseRef?.object?.sha; if(!baseSha)throw new Error('GitHub base branch could not be resolved.');
  const commit=await api('POST',`/repos/${repo}/git/commits`,token,{message:`Nexa Unity workspace snapshot ${new Date().toISOString()}`,tree:tree.sha,parents:[baseSha]}); if(!commit?.sha)throw new Error('GitHub did not return a commit SHA.');
  await api('PATCH',`/repos/${repo}/git/refs/heads/${encodeRefBranch(branch)}`,token,{sha:commit.sha,force:true});

  const entries={}; for(const row of blobRows)entries[row.path]={sha:row.sha,hash:row.hash};
  for(const ws of Object.values(workspaceStates)){
    for(const [p,v] of Object.entries(entries)) if(p.startsWith(`${ws.prefix}/project/`)) ws.remoteBlobs[p]=v.sha;
  }
  state.version=1; state.targets=state.targets||{}; state.targets[key]={repo,branch,commitSha:commit.sha,updatedAt:new Date().toISOString(),entries,workspaces:workspaceStates}; writeState(stateFile,state);

  return {ok:true,repo,branch,commitSha:commit.sha,url:`https://github.com/${repo}/tree/${encodeURIComponent(branch)}`,workspaces:snapshots.map(s=>({name:s.name,files:s.rows.length})),pullResults};
}

module.exports={validateRepo,validateBranch,workspacePrefix,isWritableRemotePath,testGithubConnection,publishGithubWorkspaces};
