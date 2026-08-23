'use strict';

const fs = require('fs');
const path = require('path');
const root = process.cwd();
const failures = [];
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch (error) { failures.push(`${file}: ${error.message}`); return {}; }
};
const exists = file => fs.existsSync(path.join(root, file));
const packageJson = readJson('package.json');
const requiredScripts = ['validate:appbuilder', 'validate:delivery', 'validate:project', 'test', 'test:acceptance', 'test:implementation', 'ui:smoke'];
for (const name of requiredScripts) {
  if (!packageJson.scripts || typeof packageJson.scripts[name] !== 'string' || !packageJson.scripts[name].trim()) {
    failures.push(`package.json is missing required script: ${name}`);
  }
}
const requiredRuntimeFiles = [
  'preload.js',
  'src/app.js',
  'src/index.html',
  'src/services/remote-command-inbox.js',
  'src/services/remote-executor.js',
  'src/services/unity-workspace.js',
  'src/services/secure-config.js',
];
for (const file of requiredRuntimeFiles) if (!exists(file)) failures.push(`Required runtime file is missing: ${file}`);
const main = packageJson.main || 'main.js';
if (packageJson.build?.asar !== true) failures.push('package.json build.asar must be true for the Windows delivery.');
const winTargets = (packageJson.build?.win?.target || []).map(item => typeof item === 'string' ? item : item?.target);
for (const target of ['nsis','portable','zip']) if (!winTargets.includes(target)) failures.push(`Windows delivery target is missing: ${target}`);
if (!exists(main)) failures.push(`Electron main entry is missing: ${main}`);
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  const matches = String(command).matchAll(/(?:^|\s|&&|;)(?:node|electron)?\s*["']?([A-Za-z0-9._/\\-]+\.(?:js|mjs|cjs))["']?/gi);
  for (const match of matches) {
    const target = match[1].replaceAll('\\', '/').replace(/^\.\//, '');
    if (!target.includes('node_modules/') && !exists(target)) failures.push(`npm script ${name} references missing file: ${target}`);
  }
}
if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log('Nexa delivery graph and npm script targets verified.');