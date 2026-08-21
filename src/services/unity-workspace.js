'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { assertAllowedPath } = require('./read-only-executor');
const { beginWorkspaceSync, sendWorkspaceBatch, finishWorkspaceSync, uploadWorkspaceArtifact } = require('./workspace-client');

const TEXT_EXT = new Set(['.cs','.unity','.prefab','.shader','.shadergraph','.mat','.json','.asmdef','.asmref','.xml','.yaml','.yml','.txt','.md','.cginc','.hlsl','.compute','.uss','.uxml','.inputactions','.controller','.anim','.meta','.asset','.rsp','.props','.csproj','.sln','.gitignore']);
const EXCLUDED_DIRS = new Set(['library','temp','obj','.git','.vs','memorycaptures']);
const MAX_FILES = 30000;
const MAX_TEXT_FILE = 512 * 1024;
const MAX_TEXT_TOTAL = 24 * 1024 * 1024;
const BATCH_TARGET = 300 * 1024;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function slash(p) { return String(p || '').replace(/\\/g, '/'); }
function workspaceUuid(root) { return 'unity_' + sha256(`${os.hostname()}|${path.resolve(root).toLowerCase()}`).slice(0, 32); }
function isUnityProject(root) { return fs.existsSync(path.join(root, 'Assets')) && fs.existsSync(path.join(root, 'ProjectSettings')); }
function projectVersion(root) {
  try {
    const text = fs.readFileSync(path.join(root,'ProjectSettings','ProjectVersion.txt'),'utf8');
    return (text.match(/m_EditorVersion:\s*(.+)/)?.[1] || '').trim();
  } catch { return ''; }
}
function kindFor(rel, ext) {
  const low = rel.toLowerCase();
  if (ext === '.cs') return 'cs';
  if (ext === '.unity') return 'scene';
  if (ext === '.prefab') return 'prefab';
  if (ext === '.mat') return 'material';
  if (['.shader','.shadergraph','.hlsl','.cginc','.compute'].includes(ext)) return 'shader';
  if (['.json','.xml','.yaml','.yml','.asmdef','.asmref','.inputactions','.asset'].includes(ext) || low.startsWith('projectsettings/') || low.startsWith('packages/')) return 'config';
  if (low.includes('log') || low.startsWith('__nexa__/')) return 'log';
  if (['.png','.jpg','.jpeg','.psd','.tga','.exr'].includes(ext)) return 'image';
  if (['.fbx','.obj','.blend','.dae'].includes(ext)) return 'model';
  if (['.wav','.mp3','.ogg'].includes(ext)) return 'audio';
  return 'file';
}
function shouldScanTop(name) {
  const low = name.toLowerCase();
  return !EXCLUDED_DIRS.has(low);
}

async function scanProject(root) {
  const rows = [];
  let textBytes = 0;
  const stats = { file_count:0,text_files:0,cs:0,scenes:0,prefabs:0,materials:0,shaders:0,configs:0,compile_error_count:0,truncated:false };
  const stack = [root];
  while (stack.length && rows.length < MAX_FILES) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fs.promises.readdir(dir,{withFileTypes:true}); } catch { continue; }
    for (const e of entries) {
      if (rows.length >= MAX_FILES) break;
      const full = path.join(dir,e.name);
      const rel = slash(path.relative(root,full));
      if (!rel) continue;
      if (e.isDirectory()) {
        const top = rel.split('/')[0];
        if (shouldScanTop(top) && !EXCLUDED_DIRS.has(e.name.toLowerCase())) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      let st; try { st = await fs.promises.stat(full); } catch { continue; }
      const ext = path.extname(e.name).toLowerCase();
      const kind = kindFor(rel,ext);
      let isText = TEXT_EXT.has(ext) || e.name === '.gitignore';
      let content = null;
      let digest = '';
      if (isText && st.size <= MAX_TEXT_FILE && textBytes + st.size <= MAX_TEXT_TOTAL) {
        try {
          const buf = await fs.promises.readFile(full);
          if (!buf.includes(0)) {
            content = buf.toString('utf8');
            digest = sha256(buf);
            textBytes += buf.length;
            stats.text_files++;
          } else isText = false;
        } catch { isText = false; }
      } else if (isText) {
        isText = false;
      }
      rows.push({relative_path:rel,file_kind:kind,extension:ext,size_bytes:st.size,modified_at:st.mtime.toISOString(),sha256:digest,is_text:isText,content_text:content});
      stats.file_count++;
      if (kind === 'cs') stats.cs++;
      if (kind === 'scene') stats.scenes++;
      if (kind === 'prefab') stats.prefabs++;
      if (kind === 'material') stats.materials++;
      if (kind === 'shader') stats.shaders++;
      if (kind === 'config') stats.configs++;
    }
  }
  stats.truncated = rows.length >= MAX_FILES;
  return {rows,stats};
}

function readJson(file, fallback={}) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fallback; } }
function editorLogTail() {
  const file = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA,'Unity','Editor','Editor.log') : '';
  if (!file || !fs.existsSync(file)) return '';
  try {
    const st=fs.statSync(file), bytes=Math.min(st.size,220*1024), fd=fs.openSync(file,'r'), buf=Buffer.alloc(bytes);
    fs.readSync(fd,buf,0,bytes,Math.max(0,st.size-bytes)); fs.closeSync(fd); return buf.toString('utf8');
  } catch { return ''; }
}
function extractCompileErrors(text) {
  const lines=String(text||'').split(/\r?\n/); const out=[];
  for (const line of lines) {
    if (/error\s+CS\d+|\berror:\s|Shader error|Compilation failed/i.test(line)) out.push(line.slice(0,1200));
    if (out.length>=100) break;
  }
  return out;
}
async function unityProcessRunning() {
  if (process.platform !== 'win32') return false;
  try { const {stdout}=await execFileAsync('tasklist.exe',['/FI','IMAGENAME eq Unity.exe','/NH'],{windowsHide:true,timeout:4000}); return /Unity\.exe/i.test(stdout); } catch { return false; }
}
async function unityStatus(root) {
  const bridgeDir=path.join(root,'.nexa-bridge');
  const pluginState=readJson(path.join(bridgeDir,'unity-state.json'),{});
  const pluginErrors=readJson(path.join(bridgeDir,'compile-errors.json'),[]);
  const play=readJson(path.join(bridgeDir,'playmode.json'),{});
  const log=editorLogTail();
  const parsedErrors=Array.isArray(pluginErrors)&&pluginErrors.length ? pluginErrors : extractCompileErrors(log).map(message=>({message}));
  return {
    unity_process_running: await unityProcessRunning(), unity_version: projectVersion(root),
    is_playing: pluginState.is_playing === true, is_paused: pluginState.is_paused === true,
    is_compiling: pluginState.is_compiling === true, active_scene: pluginState.active_scene || '', active_scene_path: pluginState.active_scene_path || '',
    plugin_installed: fs.existsSync(path.join(root,'Assets','Editor','NexaBridge','NexaUnityBridge.cs')),
    plugin_last_update: pluginState.updated_at || '', last_playmode_event: play.last_event || '', last_playmode_at: play.updated_at || '',
    compile_errors: parsedErrors.slice(0,100), compile_error_count: parsedErrors.length,
  };
}

function virtualLogRows(root,status) {
  const rows=[]; const log=editorLogTail();
  if (log) rows.push({relative_path:'__NEXA__/UnityEditor.log',file_kind:'log',extension:'.log',size_bytes:Buffer.byteLength(log),modified_at:new Date().toISOString(),sha256:sha256(log),is_text:true,content_text:log});
  const statusText=JSON.stringify(status,null,2);
  rows.push({relative_path:'__NEXA__/unity-status.json',file_kind:'config',extension:'.json',size_bytes:Buffer.byteLength(statusText),modified_at:new Date().toISOString(),sha256:sha256(statusText),is_text:true,content_text:statusText});
  return rows;
}

function batchRows(rows) {
  const batches=[]; let current=[]; let bytes=0;
  for (const row of rows) {
    const size=Buffer.byteLength(JSON.stringify(row));
    if (current.length && (bytes+size>BATCH_TARGET || current.length>=40)) { batches.push(current); current=[]; bytes=0; }
    current.push(row); bytes+=size;
  }
  if (current.length) batches.push(current); return batches;
}

async function maybeUploadArtifacts(root, endpoint, token, uuid, screenshotPermission) {
  if (!screenshotPermission) return [];
  const dir=path.join(root,'.nexa-bridge'); const uploaded=[];
  for (const [kind,name] of [['scene_view','scene-view.png'],['game_view','game-view.png']]) {
    const file=path.join(dir,name); if (!fs.existsSync(file)) continue;
    try {
      const st=await fs.promises.stat(file); if (st.size<=0 || st.size>6*1024*1024) continue;
      const data=await fs.promises.readFile(file);
      await uploadWorkspaceArtifact(endpoint,token,{workspace_uuid:uuid,artifact_kind:kind,mime_type:'image/png',data_base64:data.toString('base64')});
      uploaded.push(kind);
    } catch {}
  }
  return uploaded;
}

async function buildUnityMirrorSnapshot({root,allowedRoots}) {
  const resolved=assertAllowedPath(root,allowedRoots);
  if (!isUnityProject(resolved)) throw new Error(`Not a Unity project: ${resolved}`);
  const uuid=workspaceUuid(resolved), name=path.basename(resolved);
  const status=await unityStatus(resolved);
  const scanned=await scanProject(resolved);
  scanned.stats.compile_error_count=status.compile_error_count||0;
  const rows=scanned.rows.concat(virtualLogRows(resolved,status));
  scanned.stats.file_count=rows.length;
  return {root:resolved,workspace_uuid:uuid,name,project_version:status.unity_version,status,stats:scanned.stats,rows};
}

async function syncUnityProject({root,allowedRoots,endpoint,token,screenshotPermission=false}) {
  const snapshot=await buildUnityMirrorSnapshot({root,allowedRoots});
  const syncId='sync_'+crypto.randomBytes(12).toString('hex');
  await beginWorkspaceSync(endpoint,token,{workspace_uuid:snapshot.workspace_uuid,name:snapshot.name,project_version:snapshot.project_version,sync_id:syncId,status:snapshot.status,stats:snapshot.stats});
  for (const files of batchRows(snapshot.rows)) await sendWorkspaceBatch(endpoint,token,{workspace_uuid:snapshot.workspace_uuid,sync_id:syncId,files});
  const artifacts=await maybeUploadArtifacts(snapshot.root,endpoint,token,snapshot.workspace_uuid,screenshotPermission);
  await finishWorkspaceSync(endpoint,token,{workspace_uuid:snapshot.workspace_uuid,sync_id:syncId,status:snapshot.status,stats:snapshot.stats});
  return {workspace_uuid:snapshot.workspace_uuid,name:snapshot.name,file_count:snapshot.rows.length,artifacts,status:snapshot.status,stats:snapshot.stats};
}

const UNITY_PLUGIN = String.raw`using UnityEngine;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine.SceneManagement;
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;

[InitializeOnLoad]
public static class NexaUnityBridge {
    static string Root => Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
    static string Dir => Path.Combine(Root, ".nexa-bridge");
    static string RequestFile => Path.Combine(Dir, "request.json");
    static DateTime lastTick = DateTime.MinValue;
    static DateTime lastRequestWrite = DateTime.MinValue;
    static readonly List<string> compileErrors = new List<string>();

    static NexaUnityBridge() {
        Directory.CreateDirectory(Dir);
        EditorApplication.update += Tick;
        EditorApplication.playModeStateChanged += OnPlayMode;
        CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompiled;
        WriteState();
    }

    static void Tick() {
        if ((DateTime.UtcNow-lastTick).TotalSeconds < 2) return;
        lastTick=DateTime.UtcNow; WriteState();
        try {
            if (!File.Exists(RequestFile)) return;
            var wt=File.GetLastWriteTimeUtc(RequestFile); if (wt<=lastRequestWrite) return; lastRequestWrite=wt;
            var text=File.ReadAllText(RequestFile);
            if (text.Contains("capture_scene")) CaptureScene();
            if (text.Contains("capture_game")) CaptureGame();
        } catch(Exception e) { File.WriteAllText(Path.Combine(Dir,"capture-error.txt"),e.ToString()); }
    }

    static void WriteState() {
        var scene=SceneManager.GetActiveScene();
        var json="{"+
            "\"updated_at\":\""+DateTime.UtcNow.ToString("o")+"\","+
            "\"unity_version\":\""+Escape(Application.unityVersion)+"\","+
            "\"is_playing\":"+(EditorApplication.isPlaying?"true":"false")+","+
            "\"is_paused\":"+(EditorApplication.isPaused?"true":"false")+","+
            "\"is_compiling\":"+(EditorApplication.isCompiling?"true":"false")+","+
            "\"active_scene\":\""+Escape(scene.name)+"\","+
            "\"active_scene_path\":\""+Escape(scene.path)+"\"}";
        File.WriteAllText(Path.Combine(Dir,"unity-state.json"),json);
    }

    static void OnPlayMode(PlayModeStateChange state) {
        File.WriteAllText(Path.Combine(Dir,"playmode.json"),"{\"last_event\":\""+state+"\",\"updated_at\":\""+DateTime.UtcNow.ToString("o")+"\"}");
        WriteState();
    }
    static void OnAssemblyCompiled(string assemblyPath, CompilerMessage[] messages) {
        foreach(var m in messages) if(m.type==CompilerMessageType.Error) compileErrors.Add(m.file+"("+m.line+","+m.column+"): "+m.message);
        if(compileErrors.Count>100) compileErrors.RemoveRange(0,compileErrors.Count-100);
        var sb=new StringBuilder("[");
        for(int i=0;i<compileErrors.Count;i++){ if(i>0)sb.Append(','); sb.Append("{\"message\":\"").Append(Escape(compileErrors[i])).Append("\"}"); }
        sb.Append(']'); File.WriteAllText(Path.Combine(Dir,"compile-errors.json"),sb.ToString());
    }
    static string Escape(string s){ return (s??"").Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n"); }

    static void CaptureScene() {
        var sv=SceneView.lastActiveSceneView; if(sv==null || sv.camera==null) return;
        CaptureCamera(sv.camera,Path.Combine(Dir,"scene-view.png"),1280,720);
    }
    static void CaptureGame() {
        Camera cam=Camera.main; if(cam==null) cam=UnityEngine.Object.FindObjectOfType<Camera>();
        if(cam==null) return; CaptureCamera(cam,Path.Combine(Dir,"game-view.png"),1280,720);
    }
    static void CaptureCamera(Camera cam,string file,int width,int height) {
        var oldTarget=cam.targetTexture; var oldActive=RenderTexture.active;
        var rt=new RenderTexture(width,height,24,RenderTextureFormat.ARGB32); var tex=new Texture2D(width,height,TextureFormat.RGB24,false);
        try { cam.targetTexture=rt; cam.Render(); RenderTexture.active=rt; tex.ReadPixels(new Rect(0,0,width,height),0,0); tex.Apply(); File.WriteAllBytes(file,tex.EncodeToPNG()); }
        finally { cam.targetTexture=oldTarget; RenderTexture.active=oldActive; UnityEngine.Object.DestroyImmediate(tex); rt.Release(); UnityEngine.Object.DestroyImmediate(rt); }
    }
}
`;

async function installUnityIntegration(root, allowedRoots) {
  const resolved=assertAllowedPath(root,allowedRoots); if (!isUnityProject(resolved)) throw new Error('The selected folder is not a Unity project.');
  const dir=path.join(resolved,'Assets','Editor','NexaBridge'); await fs.promises.mkdir(dir,{recursive:true});
  const file=path.join(dir,'NexaUnityBridge.cs'); await fs.promises.writeFile(file,UNITY_PLUGIN,'utf8');
  await fs.promises.mkdir(path.join(resolved,'.nexa-bridge'),{recursive:true});
  return {ok:true,file};
}
async function requestUnityCapture(root, allowedRoots) {
  const resolved=assertAllowedPath(root,allowedRoots); const dir=path.join(resolved,'.nexa-bridge'); await fs.promises.mkdir(dir,{recursive:true});
  await fs.promises.writeFile(path.join(dir,'request.json'),JSON.stringify({capture_scene:true,capture_game:true,requested_at:new Date().toISOString()},null,2),'utf8');
  return {ok:true};
}

module.exports={isUnityProject,projectVersion,scanProject,unityStatus,buildUnityMirrorSnapshot,syncUnityProject,installUnityIntegration,requestUnityCapture,workspaceUuid};
