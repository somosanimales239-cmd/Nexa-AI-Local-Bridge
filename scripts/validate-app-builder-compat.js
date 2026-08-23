'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const supported = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const flagPattern = new RegExp('[a-z]', 'i');
const wordPattern = new RegExp('[A-Za-z0-9_$]');

function scan(content, extension) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const closing = { '}': '{', ']': '[', ')': '(' };
  const stack = [];
  const issues = [];
  let line = 1;
  let column = 0;
  let state = 'normal';
  let escaped = false;
  let regexClass = false;
  let canStartRegex = true;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';
    column += 1;

    if (state === 'line_comment') {
      if (char === '\n') { state = 'normal'; line += 1; column = 0; canStartRegex = true; }
      continue;
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') { state = 'normal'; i += 1; column += 1; continue; }
      if (char === '\n') { line += 1; column = 0; }
      continue;
    }
    if (state === 'single_quote' || state === 'double_quote' || state === 'template') {
      if (char === '\n') { line += 1; column = 0; }
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'single_quote' && char === "'") ||
          (state === 'double_quote' && char === '"') ||
          (state === 'template' && char === '`')) {
        state = 'normal';
        canStartRegex = false;
      }
      continue;
    }
    if (state === 'regex') {
      if (char === '\n') {
        issues.push({ line, column, message: 'Unterminated regular-expression literal.' });
        state = 'normal'; line += 1; column = 0; canStartRegex = true;
        continue;
      }
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '[') { regexClass = true; continue; }
      if (char === ']' && regexClass) { regexClass = false; continue; }
      if (char === '/' && !regexClass) {
        state = 'normal';
        while (i + 1 < content.length && flagPattern.test(content[i + 1])) { i += 1; column += 1; }
        canStartRegex = false;
      }
      continue;
    }

    if (char === '\n') { line += 1; column = 0; canStartRegex = true; continue; }
    if (char === '/' && next === '/') { state = 'line_comment'; i += 1; column += 1; continue; }
    if (char === '/' && next === '*') { state = 'block_comment'; i += 1; column += 1; continue; }
    if (char === "'") { state = 'single_quote'; escaped = false; continue; }
    if (char === '"') { state = 'double_quote'; escaped = false; continue; }
    if (char === '`' && supported.has(`.${extension}`)) { state = 'template'; escaped = false; continue; }
    if (char === '/' && supported.has(`.${extension}`) && canStartRegex && next !== '=' && next !== '') {
      state = 'regex'; escaped = false; regexClass = false; continue;
    }

    if (Object.prototype.hasOwnProperty.call(pairs, char)) {
      stack.push({ char, line, column });
      canStartRegex = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(closing, char)) {
      const expected = closing[char];
      const top = stack.length ? stack[stack.length - 1] : null;
      if (!top || top.char !== expected) issues.push({ line, column, message: `Unexpected closing delimiter ${char}.` });
      else stack.pop();
      canStartRegex = false;
      continue;
    }

    if (wordPattern.test(char)) canStartRegex = false;
    else if (!new RegExp('\\s').test(char)) canStartRegex = !['.', ']', ')'].includes(char);
  }

  if (state === 'block_comment') issues.push({ line, column: Math.max(1, column), message: 'Unterminated block comment.' });
  if (state === 'single_quote' || state === 'double_quote' || state === 'template') issues.push({ line, column: Math.max(1, column), message: 'Unterminated string or template literal.' });
  if (state === 'regex') issues.push({ line, column: Math.max(1, column), message: 'Unterminated regular-expression literal.' });
  for (const open of stack.reverse()) issues.push({ line: open.line, column: open.column, message: `Opening delimiter ${open.char} is not closed with ${pairs[open.char]}.` });
  return issues;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'release') continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (supported.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out;
}

const failures = [];
for (const file of walk(root)) {
  const extension = path.extname(file).slice(1).toLowerCase();
  const issues = scan(fs.readFileSync(file, 'utf8'), extension);
  for (const issue of issues) failures.push(`${path.relative(root, file)}:${issue.line}:${issue.column} ${issue.message}`);
}

if (failures.length) {
  console.error('Nexa App Builder compatibility scan failed:');
  console.error(failures.map(item => `- ${item}`).join('\n'));
  process.exit(1);
}

console.log('Nexa App Builder delimiter/regex compatibility scan passed.');
