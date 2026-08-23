'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const { executeReadOnlyCommand, assertAllowedPath } = require('./read-only-executor');
const { unityStatus, requestUnityAction, isUnityProject } = require('./unity-workspace');

const MAX_TEXT_WRITE = 6 * 1024 * 1024;
const MAX_BINARY_WRITE = 25 * 1024 * 1024;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT = 120000;
const MAX_PROCESS_TIMEOUT = 15 * 60 * 1000;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

const ACTION_CAPABILITIES = Object.freeze({
  computer_status: 'read_files', list_drives: 'read_files', list_directory: 'read_files', read_file: 'read_files',
  file_info: 'read_files', file_hash: 'read_files', find_files: 'read_files', find_file: 'read_files',
  get_processes: 'read_files', get_gpu_status: 'read_files', get_cuda_status: 'read_files',
  write_text_file: 'write_files', write_base64_file: 'write_files', write_attachment_file: 'write_files', create_directory: 'write_files', delete_path: 'write_files',
  copy_path: 'write_files', move_path: 'write_files', download_bridge_asset: 'write_files', upload_bridge_file: 'read_files',
  run_cmd: 'cmd', run_powershell: 'powershell', run_python: 'python', run_git: 'git', run_process: 'cmd',
  run_blender: 'blender', start_local_process: 'local_servers', stop_process: 'local_servers',
  download_file: 'browser', open_url: 'browser', capture_desktop: 'screenshots',
  unity_status: 'read_files', unity_refresh: 'write_files', unity_capture: 'screenshots', unity_play: 'write_files', unity_stop: 'write_files',
  unity_pause: 'write_files', unity_unpause: 'write_files', unity_open_scene: 'write_files', unity_save_scene: 'write_files',
  unity_execute_menu_item: 'write_files', unity_editor_job: 'write_files', unity_wait_for_compile: 'read_files',
});

function redactOutput(value) {
  return String(value ?? '')
    .replace(/Authorization\s*:\s*Bearer\s+[^\s]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/nexa_[A-Za-z0-9_-]{8,}/g, '[PAIRING_TOKEN_REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[API_KEY_REDACTED]')
    .replace(/([?&](?:access_token|token|api_key|apikey|auth|authorization|k)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function sha256File(file) { return sha256Buffer(fs.readFileSync(file)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeId(value) { return String(value || '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'command'; }

function ensureCapability(action, context) {
  const required = ACTION_CAPABILITIES[action];
  if (!required) throw new Error(`Unsupported remote action: ${action}.`);
  if (!context?.policy?.canExecute(required)) throw new Error(`${action} requires Hostinger permission: ${required}.`);
  if (action === 'download_file' && !context.policy.canExecute('write_files')) throw new Error('download_file also requires Write Files permission.');
  const fullComputerActions=new Set(['run_cmd','run_powershell','run_python','run_git','run_process','run_blender','start_local_process','stop_process','unity_editor_job','capture_desktop','open_url']);
  if (fullComputerActions.has(action) && context.policy.fullComputerMode !== true) throw new Error(`${action} requires Full Computer Mode in Hostinger in addition to ${required}.`);
  return required;
}

function isConfiguredRoot(target, allowedRoots) {
  const key=path.resolve(target).replace(/[\\/]+$/,'').toLowerCase();
  return (Array.isArray(allowedRoots)?allowedRoots:[]).some(root=>path.resolve(String(root||'')).replace(/[\\/]+$/,'').toLowerCase()===key);
}

function resolveCwd(value, allowedRoots) {
  if (!value) return undefined;
  const cwd = assertAllowedPath(value, allowedRoots);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
  return cwd;
}

async function runExecutable(executable, args, options = {}) {
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeout_ms || DEFAULT_PROCESS_TIMEOUT), MAX_PROCESS_TIMEOUT));
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(executable, Array.isArray(args) ? args.map(v => String(v)) : [], {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...(options.env && typeof options.env === 'object' ? options.env : {}) },
    });
    const append = (target, chunk) => {
      const next = Buffer.concat([target, Buffer.from(chunk)]);
      return next.length > MAX_PROCESS_OUTPUT ? next.subarray(next.length - MAX_PROCESS_OUTPUT) : next;
    };
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Process timed out after ${timeoutMs} ms: ${executable}`));
    }, timeoutMs);
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        executable,
        exit_code: code,
        stdout: redactOutput(stdout.toString('utf8')),
        stderr: redactOutput(stderr.toString('utf8')),
        output_truncated: stdout.length >= MAX_PROCESS_OUTPUT || stderr.length >= MAX_PROCESS_OUTPUT,
      });
    });
  });
}


function requireProcessSuccess(result, args = {}) {
  if (result && Number(result.exit_code) !== 0 && args.allow_nonzero_exit !== true) {
    const detail=String(result.stderr||result.stdout||'').trim().slice(0,4000);
    throw new Error(`Process exited with code ${result.exit_code}${detail?`: ${detail}`:''}`);
  }
  return result;
}

class BackupTransaction {
  constructor({ userDataPath, commandId }) {
    this.commandId = safeId(commandId);
    this.root = path.join(userDataPath, 'backups', this.commandId);
    this.entries = [];
    this.totalBytes = 0;
    fs.mkdirSync(this.root, { recursive: true });
  }

  async backup(target) {
    const resolved = path.resolve(target);
    if (this.entries.some(row => row.target.toLowerCase() === resolved.toLowerCase())) return;
    if (!fs.existsSync(resolved)) {
      this.entries.push({ target: resolved, existed: false, type: 'missing' });
      return;
    }
    const stat = await fs.promises.stat(resolved);
    const index = String(this.entries.length).padStart(4, '0');
    const backupPath = path.join(this.root, index);
    if (stat.isFile()) {
      this.totalBytes += stat.size;
      if (this.totalBytes > MAX_BACKUP_BYTES) throw new Error('Transactional backup exceeds the 256 MB safety limit. Split the job or use explicit external backup.');
      await fs.promises.copyFile(resolved, backupPath);
      this.entries.push({ target: resolved, existed: true, type: 'file', backup: backupPath });
      return;
    }
    if (stat.isDirectory()) {
      let dirBytes = 0;
      const stack = [resolved];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of await fs.promises.readdir(dir, { withFileTypes:true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile()) dirBytes += (await fs.promises.stat(full)).size;
          if (this.totalBytes + dirBytes > MAX_BACKUP_BYTES) throw new Error('Transactional backup exceeds the 256 MB safety limit.');
        }
      }
      this.totalBytes += dirBytes;
      await fs.promises.cp(resolved, backupPath, { recursive:true, force:true });
      this.entries.push({ target: resolved, existed: true, type: 'directory', backup: backupPath });
      return;
    }
    throw new Error(`Unsupported backup target type: ${resolved}`);
  }

  async rollback() {
    const restored = [];
    for (const row of [...this.entries].reverse()) {
      try {
        if (!row.existed) {
          await fs.promises.rm(row.target, { recursive:true, force:true });
        } else if (row.type === 'file') {
          await fs.promises.mkdir(path.dirname(row.target), { recursive:true });
          await fs.promises.copyFile(row.backup, row.target);
        } else if (row.type === 'directory') {
          await fs.promises.rm(row.target, { recursive:true, force:true });
          await fs.promises.cp(row.backup, row.target, { recursive:true, force:true });
        }
        restored.push(row.target);
      } catch {}
    }
    return restored;
  }

  async finalize() {
    try { await fs.promises.writeFile(path.join(this.root, 'manifest.json'), JSON.stringify({ command_id:this.commandId, entries:this.entries, total_bytes:this.totalBytes }, null, 2)); } catch {}
  }
}

async function writeTextFile(args, context, tx) {
  const target = assertAllowedPath(args.path, context.allowedRoots);
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content) > MAX_TEXT_WRITE) throw new Error('write_text_file exceeds the 6 MB limit.');
  if (args.expected_sha256 && fs.existsSync(target) && sha256File(target) !== String(args.expected_sha256).toLowerCase()) throw new Error(`Concurrent edit protection failed for ${target}: SHA-256 does not match.`);
  await tx.backup(target);
  await fs.promises.mkdir(path.dirname(target), { recursive:true });
  const tmp = `${target}.nexa-tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, target).catch(async () => { await fs.promises.copyFile(tmp, target); await fs.promises.rm(tmp,{force:true}); });
  return { path:target, bytes:Buffer.byteLength(content), sha256:sha256File(target) };
}

async function writeBase64File(args, context, tx) {
  const target = assertAllowedPath(args.path, context.allowedRoots);
  const buffer = Buffer.from(String(args.content_base64 || ''), 'base64');
  if (buffer.length > MAX_BINARY_WRITE) throw new Error('write_base64_file exceeds the 25 MB limit.');
  if (args.sha256 && sha256Buffer(buffer) !== String(args.sha256).toLowerCase()) throw new Error('write_base64_file payload SHA-256 mismatch.');
  await tx.backup(target);
  await fs.promises.mkdir(path.dirname(target), { recursive:true });
  await fs.promises.writeFile(target, buffer);
  return { path:target, bytes:buffer.length, sha256:sha256Buffer(buffer) };
}


async function writeAttachmentFile(args, context, tx) {
  const name=String(args.attachment_name||args.name||'').trim();
  if(!name) throw new Error('write_attachment_file requires args.attachment_name.');
  const attachments=Array.isArray(context.attachments)?context.attachments:[];
  const attachment=attachments.find(row=>String(row.filename||'').toLowerCase()===name.toLowerCase());
  if(!attachment || !Buffer.isBuffer(attachment.buffer)) throw new Error(`Email attachment was not found: ${name}`);
  const target=assertAllowedPath(args.path,context.allowedRoots);
  if(args.sha256 && sha256Buffer(attachment.buffer)!==String(args.sha256).toLowerCase()) throw new Error(`Attachment SHA-256 mismatch for ${name}.`);
  await tx.backup(target);
  await fs.promises.mkdir(path.dirname(target),{recursive:true});
  const tmp=`${target}.nexa-attachment-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp,attachment.buffer);
  await fs.promises.rename(tmp,target).catch(async()=>{await fs.promises.copyFile(tmp,target);await fs.promises.rm(tmp,{force:true});});
  return {path:target,attachment_name:name,bytes:attachment.buffer.length,sha256:sha256File(target),content_type:attachment.content_type||'application/octet-stream'};
}

async function createDirectory(args, context, tx) {
  const target = assertAllowedPath(args.path, context.allowedRoots);
  await tx.backup(target);
  await fs.promises.mkdir(target, { recursive:true });
  return { path:target };
}

async function deletePath(args, context, tx) {
  const target = assertAllowedPath(args.path, context.allowedRoots);
  if (isConfiguredRoot(target, context.allowedRoots)) throw new Error('Deleting an Allowed Folder root itself is blocked. Remove or narrow the Allowed Folder manually first.');
  await tx.backup(target);
  if (!fs.existsSync(target)) return { path:target, existed:false };
  const stat = await fs.promises.stat(target);
  if (stat.isDirectory() && args.recursive !== true) throw new Error('Deleting a directory requires args.recursive=true.');
  await fs.promises.rm(target, { recursive:stat.isDirectory(), force:true });
  return { path:target, existed:true, type:stat.isDirectory()?'directory':'file' };
}

async function copyPath(args, context, tx) {
  const source = assertAllowedPath(args.source, context.allowedRoots);
  const target = assertAllowedPath(args.destination, context.allowedRoots);
  if (!fs.existsSync(source)) throw new Error(`Copy source does not exist: ${source}`);
  await tx.backup(target);
  const stat = await fs.promises.stat(source);
  await fs.promises.mkdir(path.dirname(target), { recursive:true });
  if (stat.isDirectory()) await fs.promises.cp(source, target, { recursive:true, force:true });
  else await fs.promises.copyFile(source, target);
  return { source, destination:target, type:stat.isDirectory()?'directory':'file' };
}

async function movePath(args, context, tx) {
  const source = assertAllowedPath(args.source, context.allowedRoots);
  const target = assertAllowedPath(args.destination, context.allowedRoots);
  if (!fs.existsSync(source)) throw new Error(`Move source does not exist: ${source}`);
  if (isConfiguredRoot(source, context.allowedRoots)) throw new Error('Moving an Allowed Folder root itself is blocked.');
  await tx.backup(source);
  await tx.backup(target);
  await fs.promises.mkdir(path.dirname(target), { recursive:true });
  await fs.promises.rename(source, target).catch(async () => {
    const stat = await fs.promises.stat(source);
    if (stat.isDirectory()) { await fs.promises.cp(source,target,{recursive:true,force:true}); await fs.promises.rm(source,{recursive:true,force:true}); }
    else { await fs.promises.copyFile(source,target); await fs.promises.rm(source,{force:true}); }
  });
  return { source, destination:target };
}

async function downloadFile(args, context, tx) {
  const url = new URL(String(args.url || ''));
  if (url.protocol !== 'https:') throw new Error('download_file accepts HTTPS URLs only.');
  const target = assertAllowedPath(args.path, context.allowedRoots);
  await tx.backup(target);
  await fs.promises.mkdir(path.dirname(target), { recursive:true });
  const tmp = `${target}.nexa-download-${Date.now()}`;
  const result = await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp, { flags:'w' });
    let bytes = 0;
    const request = https.get(url, { headers:{'User-Agent':'Nexa-AI-Local-Bridge/1.7.0'} }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(); fs.rmSync(tmp,{force:true}); reject(new Error('download_file redirects are blocked; provide the final HTTPS URL.')); return;
      }
      if (response.statusCode !== 200) { file.close(); fs.rmSync(tmp,{force:true}); reject(new Error(`download_file HTTP ${response.statusCode}.`)); return; }
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > Math.min(Number(args.max_bytes || MAX_DOWNLOAD), MAX_DOWNLOAD)) request.destroy(new Error('download_file exceeded the maximum allowed size.'));
      });
      response.pipe(file);
      file.on('finish', () => { file.close(() => resolve({ bytes })); });
    });
    request.setTimeout(30000, () => request.destroy(new Error('download_file timed out.')));
    request.on('error', error => { try { file.close(); fs.rmSync(tmp,{force:true}); } catch {} reject(error); });
  });
  if (args.sha256 && sha256File(tmp) !== String(args.sha256).toLowerCase()) { await fs.promises.rm(tmp,{force:true}); throw new Error('Downloaded file SHA-256 mismatch.'); }
  await fs.promises.rename(tmp,target).catch(async()=>{await fs.promises.copyFile(tmp,target);await fs.promises.rm(tmp,{force:true});});
  return { path:target, bytes:result.bytes, sha256:sha256File(target), source_host:url.host };
}



async function downloadBridgeAsset(args, context, tx) {
  if(!context?.bridgeFiles?.download)throw new Error('Hostinger Bridge file download is not configured.');
  const target=assertAllowedPath(args.path,context.allowedRoots);const assetId=String(args.asset_id||args.id||'').trim();if(!assetId)throw new Error('download_bridge_asset requires args.asset_id.');
  await tx.backup(target);const payload=await context.bridgeFiles.download(assetId,Math.min(Number(args.max_bytes||MAX_DOWNLOAD),MAX_DOWNLOAD));if(!payload||!Buffer.isBuffer(payload.buffer))throw new Error('Bridge asset download returned invalid data.');
  const sha=sha256Buffer(payload.buffer);const expected=String(args.sha256||payload.sha256||'').trim().toLowerCase();if(expected&&sha!==expected)throw new Error('Bridge asset SHA-256 mismatch.');
  await fs.promises.mkdir(path.dirname(target),{recursive:true});const tmp=`${target}.nexa-bridge-${Date.now()}`;await fs.promises.writeFile(tmp,payload.buffer);await fs.promises.rename(tmp,target).catch(async()=>{await fs.promises.copyFile(tmp,target);await fs.promises.rm(tmp,{force:true});});
  return{path:target,asset_id:assetId,bytes:payload.buffer.length,sha256:sha,source_name:payload.filename||''};
}

async function uploadBridgeFileAction(args, context) {
  if(!context?.bridgeFiles?.upload)throw new Error('Hostinger Bridge file upload is not configured.');
  const source=assertAllowedPath(args.path,context.allowedRoots);const stat=await fs.promises.stat(source);if(!stat.isFile())throw new Error('upload_bridge_file requires a file path.');if(stat.size>MAX_DOWNLOAD)throw new Error('upload_bridge_file exceeds 100 MiB.');
  const buffer=await fs.promises.readFile(source);const sha=sha256Buffer(buffer);const result=await context.bridgeFiles.upload(path.basename(source),buffer,sha);return{path:source,bytes:buffer.length,sha256:sha,bridge_file:result.file||result};
}

async function captureDesktop(args, context, tx) {
  if(process.platform!=='win32')throw new Error('capture_desktop is available on Windows only.');
  const target=assertAllowedPath(args.path,context.allowedRoots);await tx.backup(target);await fs.promises.mkdir(path.dirname(target),{recursive:true});
  const ps=`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${target.replace(/'/g,"''")}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose();`;
  const result=await runExecutable('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',ps],{timeout_ms:args.timeout_ms||30000});requireProcessSuccess(result,args);const st=await fs.promises.stat(target);return{path:target,bytes:st.size,sha256:sha256File(target)};
}

function openUrl(args) {
  const url=new URL(String(args.url||''));if(!['https:','http:'].includes(url.protocol))throw new Error('open_url accepts HTTP/HTTPS URLs only.');
  const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url.toString()],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();return{opened:true,url:url.toString(),pid:child.pid};
}

function startDetachedProcess(executable,args,options={}){
  const child=spawn(executable,Array.isArray(args)?args.map(String):[],{cwd:options.cwd,windowsHide:true,shell:false,detached:true,stdio:'ignore',env:{...process.env}});
  child.unref();
  return {executable,pid:child.pid,started:true};
}

async function stopProcess(pid){
  const numeric=Number(pid); if(!Number.isInteger(numeric)||numeric<=0)throw new Error('stop_process requires a positive integer args.pid.');
  if(process.platform==='win32') return runExecutable('taskkill.exe',['/PID',String(numeric),'/T','/F'],{timeout_ms:30000});
  try{process.kill(numeric,'SIGTERM');return{pid:numeric,stopped:true};}catch(error){throw new Error(`Could not stop process ${numeric}: ${error.message}`);}
}

function selectUnityRoot(args, context) {
  const requested = args.project_root || args.root || context.unityRoots?.[0];
  if (!requested) throw new Error('No Unity project root is configured for this action.');
  const root = assertAllowedPath(requested, context.allowedRoots);
  if (!isUnityProject(root)) throw new Error(`Not a Unity project: ${root}`);
  return root;
}

async function waitForUnityCompile(root, timeoutMs = 120000) {
  const timeout = Math.max(5000, Math.min(Number(timeoutMs || 120000), 5 * 60 * 1000));
  const start = Date.now();
  let sawCompiling = false;
  await sleep(800);
  while (Date.now() - start < timeout) {
    const status = await unityStatus(root);
    if (status.is_compiling || ['started','compiling'].includes(status.compilation_phase)) sawCompiling = true;
    const settled = !status.is_compiling && !['started','compiling'].includes(status.compilation_phase);
    if (settled && (sawCompiling || Date.now() - start > 3000)) {
      return { ...status, saw_compiling:sawCompiling, wait_ms:Date.now()-start };
    }
    await sleep(700);
  }
  throw new Error(`Unity compilation did not settle within ${timeout} ms.`);
}

function editorJobScript(commandId, body) {
  const className = `NexaRemoteJob_${safeId(commandId).replace(/\W/g,'_')}`;
  const escapedId = String(commandId).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  return `using UnityEngine;\nusing UnityEditor;\nusing System;\nusing System.IO;\n\n[InitializeOnLoad]\npublic static class ${className}\n{\n    static ${className}() { EditorApplication.delayCall += Run; }\n    static void Run()\n    {\n        string root = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));\n        string dir = Path.Combine(root, ".nexa-bridge", "remote-results");\n        Directory.CreateDirectory(dir);\n        try\n        {\n${String(body||'').split('\n').map(line=>'            '+line).join('\n')}\n            AssetDatabase.SaveAssets();\n            File.WriteAllText(Path.Combine(dir, "${escapedId}.json"), "{\\\"ok\\\":true,\\\"completed_at\\\":\\\"" + DateTime.UtcNow.ToString("o") + "\\\"}");\n        }\n        catch(Exception e)\n        {\n            File.WriteAllText(Path.Combine(dir, "${escapedId}.json"), "{\\\"ok\\\":false,\\\"error\\\":\\\"" + Escape(e.ToString()) + "\\\"}");\n        }\n        finally\n        {\n            EditorApplication.delayCall += () => { AssetDatabase.DeleteAsset("Assets/Editor/NexaRemoteJobs/${className}.cs"); AssetDatabase.Refresh(); };\n        }\n    }\n    static string Escape(string s) { return (s??"").Replace("\\\\","\\\\\\\\").Replace("\\\"","\\\\\\\"").Replace("\\r","\\\\r").Replace("\\n","\\\\n"); }\n}\n`;
}

async function unityEditorJob(args, context, tx, commandId) {
  const root = selectUnityRoot(args, context);
  if (!String(args.code || '').trim()) throw new Error('unity_editor_job requires args.code containing the C# statements to run.');
  const affected = Array.isArray(args.backup_paths) ? args.backup_paths : [];
  if (!affected.length && args.allow_unbacked !== true) throw new Error('unity_editor_job requires args.backup_paths so affected Unity assets can be restored automatically. Set allow_unbacked=true only for an intentionally non-transactional Editor job.');
  for (const rel of affected) await tx.backup(assertAllowedPath(path.isAbsolute(rel)?rel:path.join(root,rel), context.allowedRoots));
  const jobsDir = path.join(root,'Assets','Editor','NexaRemoteJobs');
  const className = `NexaRemoteJob_${safeId(commandId).replace(/\W/g,'_')}`;
  const script = path.join(jobsDir, `${className}.cs`);
  await tx.backup(script);
  await fs.promises.mkdir(jobsDir,{recursive:true});
  const resultFile = path.join(root,'.nexa-bridge','remote-results',`${commandId}.json`);
  await fs.promises.mkdir(path.dirname(resultFile),{recursive:true});
  await fs.promises.rm(resultFile,{force:true});
  await fs.promises.writeFile(script, editorJobScript(commandId,args.code),'utf8');
  await requestUnityAction(root, context.allowedRoots, { action:'refresh_assets' });
  const timeout = Math.max(10000,Math.min(Number(args.timeout_ms||120000),5*60*1000));
  const start=Date.now();
  while(Date.now()-start<timeout){
    if(fs.existsSync(resultFile)){
      let result={}; try{result=JSON.parse(fs.readFileSync(resultFile,'utf8'));}catch{}
      if(result.ok===false) throw new Error(`Unity Editor job failed: ${String(result.error||'unknown error').slice(0,3000)}`);
      const compile=await waitForUnityCompile(root,Math.max(10000,timeout-(Date.now()-start)));
      return { project_root:root, editor_job_completed:true, compile };
    }
    await sleep(700);
  }
  throw new Error(`Unity Editor job did not complete within ${timeout} ms.`);
}

async function executeAction(actionRow, context, tx, commandId) {
  const action = String(actionRow.action || '').trim();
  ensureCapability(action, context);
  const args = actionRow.args && typeof actionRow.args === 'object' ? actionRow.args : {};
  if (['computer_status','list_drives','list_directory','read_file','file_info','file_hash','find_files','find_file','get_processes','get_gpu_status','get_cuda_status'].includes(action)) {
    return executeReadOnlyCommand({ action, capability:'read_files', args }, context);
  }
  switch(action){
    case 'write_text_file': return writeTextFile(args,context,tx);
    case 'write_base64_file': return writeBase64File(args,context,tx);
    case 'write_attachment_file': return writeAttachmentFile(args,context,tx);
    case 'create_directory': return createDirectory(args,context,tx);
    case 'delete_path': return deletePath(args,context,tx);
    case 'copy_path': return copyPath(args,context,tx);
    case 'move_path': return movePath(args,context,tx);
    case 'download_bridge_asset': return downloadBridgeAsset(args,context,tx);
    case 'upload_bridge_file': return uploadBridgeFileAction(args,context);
    case 'download_file': return downloadFile(args,context,tx);
    case 'capture_desktop': return captureDesktop(args,context,tx);
    case 'open_url': return openUrl(args);
    case 'run_cmd': return requireProcessSuccess(await runExecutable('cmd.exe',['/d','/s','/c',String(args.command||'')],{cwd:resolveCwd(args.cwd,context.allowedRoots),timeout_ms:args.timeout_ms}),args);
    case 'run_powershell': return requireProcessSuccess(await runExecutable('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',String(args.command||'')],{cwd:resolveCwd(args.cwd,context.allowedRoots),timeout_ms:args.timeout_ms}),args);
    case 'run_python': return requireProcessSuccess(await runExecutable(String(args.executable||'python.exe'),Array.isArray(args.args)?args.args:['-c',String(args.code||'')],{cwd:resolveCwd(args.cwd,context.allowedRoots),timeout_ms:args.timeout_ms}),args);
    case 'run_git': return requireProcessSuccess(await runExecutable('git.exe',Array.isArray(args.args)?args.args:[],{cwd:resolveCwd(args.cwd,context.allowedRoots),timeout_ms:args.timeout_ms}),args);
    case 'run_process': {
      const executable=String(args.executable||'').trim(); if(!executable) throw new Error('run_process requires args.executable.');
      return requireProcessSuccess(await runExecutable(executable,Array.isArray(args.args)?args.args:[],{cwd:resolveCwd(args.cwd,context.allowedRoots),timeout_ms:args.timeout_ms}),args);
    }
    case 'run_blender': { const executable=String(args.executable||'blender.exe').trim(); return requireProcessSuccess(await runExecutable(executable,Array.isArray(args.args)?args.args:[],{cwd:resolveCwd(args.cwd,context.allowedRoots),timeout_ms:args.timeout_ms}),args); }
    case 'start_local_process': { const executable=String(args.executable||'').trim(); if(!executable)throw new Error('start_local_process requires args.executable.'); return startDetachedProcess(executable,Array.isArray(args.args)?args.args:[],{cwd:resolveCwd(args.cwd,context.allowedRoots)}); }
    case 'stop_process': return stopProcess(args.pid);
    case 'unity_status': { const root=selectUnityRoot(args,context); return unityStatus(root); }
    case 'unity_refresh': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'refresh_assets'}); }
    case 'unity_capture': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'capture_views'}); }
    case 'unity_play': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'play'}); }
    case 'unity_stop': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'stop'}); }
    case 'unity_pause': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'pause'}); }
    case 'unity_unpause': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'unpause'}); }
    case 'unity_open_scene': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'open_scene',scene_path:String(args.scene_path||'')}); }
    case 'unity_save_scene': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'save_scene'}); }
    case 'unity_execute_menu_item': { const root=selectUnityRoot(args,context); return requestUnityAction(root,context.allowedRoots,{action:'execute_menu_item',menu_item:String(args.menu_item||'')}); }
    case 'unity_editor_job': return unityEditorJob(args,context,tx,commandId);
    case 'unity_wait_for_compile': { const root=selectUnityRoot(args,context); return waitForUnityCompile(root,args.timeout_ms); }
    default: throw new Error(`Unsupported remote action: ${action}.`);
  }
}

async function executeRemoteEnvelope(envelope, context) {
  const commandId = String(envelope.command_id || envelope.uuid || `cmd_${Date.now()}`);
  const tx = new BackupTransaction({ userDataPath:context.userDataPath, commandId });
  const results=[];
  const changedFiles=[];
  let rollback=null;
  let compile=null;
  try{
    const explicitBackups=Array.isArray(envelope.options?.backup_paths)?envelope.options.backup_paths:[];
    for(const p of explicitBackups){
      const root=context.unityRoots?.[0]||'';
      const target=path.isAbsolute(p)?p:path.join(root,p);
      await tx.backup(assertAllowedPath(target,context.allowedRoots));
    }
    for(let i=0;i<envelope.actions.length;i+=1){
      const row=envelope.actions[i];
      const result=await executeAction(row,context,tx,commandId);
      results.push({index:i,action:row.action,ok:true,result});
      if(result?.path && ['write_text_file','write_base64_file','write_attachment_file','create_directory','delete_path','download_file','download_bridge_asset','capture_desktop'].includes(row.action)) changedFiles.push(result.path);
      if(result?.destination && ['copy_path','move_path'].includes(row.action)) changedFiles.push(result.destination);
    }
    if(envelope.options?.verify_unity_compile===true){
      const root=selectUnityRoot({project_root:envelope.options.project_root},context);
      await requestUnityAction(root,context.allowedRoots,{action:'refresh_assets'});
      compile=await waitForUnityCompile(root,envelope.options.compile_timeout_ms||120000);
      if((compile.compile_error_count||0)>0 && envelope.options?.rollback_on_compile_error!==false){
        const restored=await tx.rollback();
        await requestUnityAction(root,context.allowedRoots,{action:'refresh_assets'});
        const afterRollback=await waitForUnityCompile(root,envelope.options.compile_timeout_ms||120000).catch(error=>({error:error.message}));
        rollback={performed:true,reason:'unity_compile_errors',restored,after_rollback_compile:afterRollback};
        return {ok:false,error:`Unity reported ${compile.compile_error_count} real compile error(s); changes were rolled back.`,changed_files:changedFiles,actions:results,compile,rollback};
      }
    }
    await tx.finalize();
    return {ok:true,changed_files:changedFiles,actions:results,compile,rollback};
  }catch(error){
    const restored=envelope.options?.rollback_on_error===false?[]:await tx.rollback();
    rollback={performed:restored.length>0,reason:'action_error',restored};
    await tx.finalize();
    return {ok:false,error:error.message,changed_files:changedFiles,actions:results,compile,rollback};
  }
}

async function executeSingleRemoteCommand(command, context) {
  if(String(command.action||'')==='remote_envelope'){
    const payload=command.args&&typeof command.args==='object'?command.args:{};
    if(!Array.isArray(payload.actions)||payload.actions.length<1||payload.actions.length>50)throw new Error('remote_envelope requires 1-50 actions.');
    return executeRemoteEnvelope({command_id:String(command.uuid||`hostinger_${Date.now()}`),actions:payload.actions,options:payload.options&&typeof payload.options==='object'?payload.options:{rollback_on_error:true}},context);
  }
  const envelope={command_id:String(command.uuid||`hostinger_${Date.now()}`),actions:[{action:command.action,args:command.args||{}}],options:{rollback_on_error:true,verify_unity_compile:false}};
  return executeRemoteEnvelope(envelope,context);
}

module.exports={
  ACTION_CAPABILITIES,
  BackupTransaction,
  runExecutable,
  waitForUnityCompile,
  executeRemoteEnvelope,
  executeSingleRemoteCommand,
};
