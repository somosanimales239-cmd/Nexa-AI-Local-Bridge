'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SUPPORTED_ACTIONS = new Set([
  'computer_status', 'list_drives', 'list_directory', 'read_file',
  'file_info', 'file_hash', 'find_files', 'find_file',
  'get_processes', 'get_gpu_status', 'get_cuda_status'
]);

function normalizeRoot(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
}

function pathWithin(targetKey, rootKey) {
  if (!targetKey || !rootKey) return false;
  return targetKey === rootKey || targetKey.startsWith(rootKey + path.sep.toLowerCase());
}

function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return { ancestor: current, suffix };
}

function canonicalCandidate(target) {
  const resolved = path.resolve(target);
  try {
    if (fs.existsSync(resolved)) return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {}
  const { ancestor, suffix } = nearestExistingAncestor(resolved);
  let realAncestor = ancestor;
  try { realAncestor = fs.realpathSync.native ? fs.realpathSync.native(ancestor) : fs.realpathSync(ancestor); } catch {}
  return path.resolve(realAncestor, ...suffix);
}

function assertAllowedPath(target, allowedRoots) {
  const raw = String(target || '').trim();
  if (!raw) throw new Error('A path is required.');
  const resolved = path.resolve(raw);
  const targetKey = resolved.toLowerCase();
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : []).map(value => path.resolve(String(value || '').trim())).filter(Boolean);
  if (!roots.length) throw new Error('No Allowed Folders are configured in Nexa AI Local Bridge.');

  const lexicalAllowed = roots.some(root => pathWithin(targetKey, normalizeRoot(root)));
  if (!lexicalAllowed) throw new Error(`Blocked by local Allowed Folders policy: ${resolved}`);

  const canonicalTarget = canonicalCandidate(resolved).toLowerCase();
  const canonicalRoots = roots.map(root => canonicalCandidate(root).replace(/[\\/]+$/, '').toLowerCase());
  const canonicalAllowed = canonicalRoots.some(root => pathWithin(canonicalTarget, root));
  if (!canonicalAllowed) throw new Error(`Blocked because the path resolves outside Allowed Folders (junction/symlink protection): ${resolved}`);
  return resolved;
}

function listDrives() {
  if (process.platform !== 'win32') return [{ path: path.parse(process.cwd()).root, available: true }];
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(drive)) drives.push({ path: drive, available: true });
    } catch {}
  }
  return drives;
}

async function listDirectory(target, allowedRoots) {
  const resolved = assertAllowedPath(target, allowedRoots);
  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  const limited = entries.slice(0, 500);
  const result = [];
  for (const entry of limited) {
    let size = null;
    let modified = null;
    try {
      const stat = await fs.promises.stat(path.join(resolved, entry.name));
      size = stat.isFile() ? stat.size : null;
      modified = stat.mtime.toISOString();
    } catch {}
    result.push({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
      size,
      modified,
    });
  }
  return { path: resolved, entries: result, total_entries: entries.length, truncated: entries.length > limited.length };
}

async function readTextFile(target, allowedRoots) {
  const resolved = assertAllowedPath(target, allowedRoots);
  const stat = await fs.promises.stat(resolved);
  if (!stat.isFile()) throw new Error('The requested path is not a file.');
  const maxBytes = 256 * 1024;
  const handle = await fs.promises.open(resolved, 'r');
  try {
    const readBytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, 0);
    if (buffer.includes(0)) throw new Error('Binary file reading is disabled in read-only phase 1.');
    return {
      path: resolved,
      encoding: 'utf-8',
      content: buffer.toString('utf8'),
      file_bytes: stat.size,
      returned_bytes: readBytes,
      truncated: stat.size > maxBytes,
    };
  } finally {
    await handle.close();
  }
}


async function fileInfo(target, allowedRoots) {
  const resolved=assertAllowedPath(target,allowedRoots);
  let stat;try{stat=await fs.promises.stat(resolved);}catch(error){if(error.code==='ENOENT')return{path:resolved,exists:false};throw error;}
  return {path:resolved,exists:true,type:stat.isDirectory()?'directory':stat.isFile()?'file':'other',size_bytes:stat.isFile()?stat.size:null,created_at:stat.birthtime?.toISOString?.()||'',modified_at:stat.mtime?.toISOString?.()||'',extension:stat.isFile()?path.extname(resolved).toLowerCase():''};
}

async function fileHash(target, allowedRoots) {
  const resolved=assertAllowedPath(target,allowedRoots);const stat=await fs.promises.stat(resolved);if(!stat.isFile())throw new Error('file_hash requires a file path.');
  const hash=crypto.createHash('sha256');const stream=fs.createReadStream(resolved);for await(const chunk of stream)hash.update(chunk);return{path:resolved,size_bytes:stat.size,sha256:hash.digest('hex')};
}

function wildcardRegex(pattern) {
  const raw=String(pattern||'*').trim()||'*';const escaped=raw.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');return new RegExp(`^${escaped}$`,'i');
}

async function findFiles(args, allowedRoots) {
  const root=assertAllowedPath(args.path||args.root,allowedRoots);const stat=await fs.promises.stat(root);if(!stat.isDirectory())throw new Error('find_files root must be a directory.');
  const rx=wildcardRegex(args.pattern||args.name||'*');const maxResults=Math.max(1,Math.min(Number(args.max_results||100),300));const maxDepth=Math.max(0,Math.min(Number(args.max_depth??12),30));const maxVisited=Math.max(100,Math.min(Number(args.max_visited||50000),150000));const deadline=Date.now()+Math.max(1000,Math.min(Number(args.timeout_ms||20000),60000));
  const wantFiles=args.include_files!==false;const wantDirs=args.include_directories===true;const results=[];const stack=[{dir:root,depth:0}];let visited=0,truncated=false;
  while(stack.length){if(Date.now()>deadline){truncated=true;break;}const item=stack.pop();let entries;try{entries=await fs.promises.readdir(item.dir,{withFileTypes:true});}catch{continue;}
    for(const entry of entries){visited++;if(visited>maxVisited){truncated=true;break;}const full=path.join(item.dir,entry.name);if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){if(wantDirs&&rx.test(entry.name)){results.push({path:full,type:'directory'});if(results.length>=maxResults){truncated=true;break;}}if(item.depth<maxDepth)stack.push({dir:full,depth:item.depth+1});}
      else if(entry.isFile()&&wantFiles&&rx.test(entry.name)){let size=null,modified='';try{const st=await fs.promises.stat(full);size=st.size;modified=st.mtime.toISOString();}catch{}results.push({path:full,type:'file',size_bytes:size,modified_at:modified});if(results.length>=maxResults){truncated=true;break;}}
    }if(truncated&&results.length>=maxResults)break;if(visited>maxVisited)break;
  }
  return{root,pattern:String(args.pattern||args.name||'*'),results,match_count:results.length,visited,truncated};
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { values.push(current); current = ''; }
    else current += ch;
  }
  values.push(current);
  return values;
}

async function getProcesses() {
  if (process.platform !== 'win32') return { processes: [], note: 'Windows process inventory is only available on Windows.' };
  const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 7000, maxBuffer: 1024 * 1024 });
  const rows = String(stdout || '').split(/\\r?\\n/).filter(Boolean).slice(0, 300).map(line => {
    const c = parseCsvLine(line);
    return { image_name: c[0] || '', pid: c[1] || '', session_name: c[2] || '', memory_usage: c[4] || '' };
  });
  return { processes: rows, truncated: rows.length >= 300 };
}

async function getGpuStatus(systemInfo) {
  if (process.platform !== 'win32') return { gpu: systemInfo?.gpu || 'Unavailable' };
  const script = "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,VideoProcessor | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', script], { windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024 });
    return { gpu: JSON.parse(String(stdout || '').trim() || 'null') };
  } catch (error) {
    return { gpu: systemInfo?.gpu || 'Unavailable', diagnostic_error: error.message };
  }
}

async function getCudaStatus() {
  if (process.platform !== 'win32') return { nvidia_smi_available: false, note: 'CUDA diagnostic is intended for Windows.' };
  try {
    const { stdout } = await execFileAsync('nvidia-smi.exe', ['--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu','--format=csv,noheader,nounits'], { windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024 });
    return { nvidia_smi_available: true, gpu_rows: String(stdout || '').trim().split(/\\r?\\n/).filter(Boolean) };
  } catch (error) {
    return { nvidia_smi_available: false, error: 'nvidia-smi was not available or returned an error.', detail: error.message };
  }
}

async function executeReadOnlyCommand(command, context) {
  if (!command || !SUPPORTED_ACTIONS.has(command.action)) throw new Error('Unsupported read-only command action.');
  if (command.capability !== 'read_files') throw new Error('Command capability is not allowed in read-only phase 1.');
  if (!context?.policy?.canExecute('read_files')) throw new Error('Read Files execution is blocked by the current server policy.');
  if (command.cancel_requested) return { cancelled: true };

  const args = command.args && typeof command.args === 'object' ? command.args : {};
  switch (command.action) {
    case 'computer_status': return { ...context.systemInfo, allowed_roots: context.allowedRoots || [] };
    case 'list_drives': return { drives: listDrives() };
    case 'list_directory': return listDirectory(args.path, context.allowedRoots);
    case 'read_file': return readTextFile(args.path, context.allowedRoots);
    case 'file_info': return fileInfo(args.path, context.allowedRoots);
    case 'file_hash': return fileHash(args.path, context.allowedRoots);
    case 'find_files': return findFiles(args, context.allowedRoots);
    case 'find_file': return findFiles({ ...args, max_results: args.max_results || 25 }, context.allowedRoots);
    case 'get_processes': return getProcesses();
    case 'get_gpu_status': return getGpuStatus(context.systemInfo);
    case 'get_cuda_status': return getCudaStatus();
    default: throw new Error('Unsupported read-only command action.');
  }
}

module.exports = { SUPPORTED_ACTIONS, assertAllowedPath, executeReadOnlyCommand, normalizeRoot, pathWithin, canonicalCandidate };
