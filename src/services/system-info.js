'use strict';

const os = require('os');
const { execFile } = require('child_process');

function firstLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const records of Object.values(interfaces)) {
    for (const item of records || []) {
      if (item && item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

function gpuName() {
  if (process.platform !== 'win32') return Promise.resolve('Unavailable');
  const script = '(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)';
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 6000, maxBuffer: 128 * 1024 },
      (error, stdout) => {
        const value = String(stdout || '').trim().split(/\r?\n/)[0] || '';
        resolve(error || !value ? 'Unavailable' : value.slice(0, 160));
      }
    );
  });
}

async function collectSystemInfo(appVersion) {
  return {
    pc_name: os.hostname() || 'Windows PC',
    os_name: process.platform === 'win32'
      ? `Windows ${os.release()}`
      : `${os.type()} ${os.release()}`,
    local_ip: firstLocalIPv4(),
    gpu: await gpuName(),
    agent_version: String(appVersion || '1.2.1'),
  };
}

module.exports = { collectSystemInfo, firstLocalIPv4 };
