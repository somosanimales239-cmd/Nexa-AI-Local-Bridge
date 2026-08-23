'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SUPPORTED_ACTIONS = new Set([
  'computer_status', 'list_drives', 'list_directory', 'read_file',
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
    case 'get_processes': return getProcesses();
    case 'get_gpu_status': return getGpuStatus(context.systemInfo);
    case 'get_cuda_status': return getCudaStatus();
    default: throw new Error('Unsupported read-only command action.');
  }
}

module.exports = { SUPPORTED_ACTIONS, assertAllowedPath, executeReadOnlyCommand, normalizeRoot, pathWithin, canonicalCandidate };
