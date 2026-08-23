'use strict';

const DIAGNOSTICS_SCHEMA_VERSION = 2;
const MAX_COMPILE_ERRORS = 100;
const MAX_SERVICE_ISSUES = 60;

function redactSecrets(value) {
  let text = String(value || '');

  const replacements = [
    [/(^|\s)(-accessToken(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gim, '$1$2[REDACTED]'],
    [/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
    [/\bnexa_[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_NEXA_TOKEN]'],
    [/\bws_[A-Za-z0-9_-]{24,}\b/g, '[REDACTED_WORKSPACE_KEY]'],
    [/(?:\?|&)(access_token|token|api_key|apikey|auth|authorization|k)=([^&#\s]+)/gi, '?$1=[REDACTED]'],
    [/\b(C:\\Users\\)[^\\\r\n]+/gi, '$1[USER]'],
  ];

  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

function normalizeMessage(value) {
  return redactSecrets(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

function isStrongCompileError(line) {
  const text = String(line || '');
  if (!text) return false;
  return (
    /\berror\s+CS\d+\b/i.test(text) ||
    /(?:^|\s)(?:Assets|Packages)[\\/].+\(\d+,\d+\)\s*:\s*error\b/i.test(text) ||
    /\bShader error(?:\s+in)?\b/i.test(text) ||
    /\bCompilation failed\b/i.test(text) ||
    /\bScriptCompilation(?:Error|Failed)\b/i.test(text) ||
    /\bCompilerError\b/i.test(text)
  );
}

function classifyServiceIssue(line) {
  const text = String(line || '');

  if (
    /\[Licensing::/i.test(text) ||
    /\bLicensing::Client\b/i.test(text) ||
    /\bentitlement(?:s)?\b/i.test(text) ||
    /\blicen[cs](?:e|ing).*(?:error|failed|failure|denied|missing|not found|404)\b/i.test(text)
  ) return 'unity_licensing';

  if (
    /\bPackage Manager\b/i.test(text) ||
    /\bUPM\b/.test(text) ||
    /\bcom\.unity\.package-manager\b/i.test(text)
  ) return 'package_manager';

  if (
    /\bUnityConnect\b/i.test(text) ||
    /\bUnity Services?\b/i.test(text) ||
    /\bServices Core\b/i.test(text) ||
    /\bAnalytics\b/i.test(text)
  ) return 'unity_services';

  if (
    /\b(?:TLS|SSL|certificate|DNS|socket|network)\b.*\b(?:error|failed|failure|timeout|timed out|unreachable)\b/i.test(text)
  ) return 'connectivity';

  return '';
}

function dedupeEntries(entries, maxItems) {
  const map = new Map();
  for (const item of entries || []) {
    const message = normalizeMessage(typeof item === 'string' ? item : item?.message);
    if (!message) continue;
    const category = String(item?.category || '');
    const source = String(item?.source || '');
    const code = String(item?.code || '');
    const key = `${category}|${code}|${message}`.toLowerCase();
    const occurrences = Number(item?.occurrences || 1);
    if (map.has(key)) {
      map.get(key).occurrences += Number.isFinite(occurrences) && occurrences > 0 ? occurrences : 1;
      continue;
    }
    map.set(key, {
      message,
      ...(category ? { category } : {}),
      ...(code ? { code } : {}),
      ...(source ? { source } : {}),
      occurrences: Number.isFinite(occurrences) && occurrences > 0 ? occurrences : 1,
    });
  }
  return Array.from(map.values()).slice(0, maxItems);
}

function compilerCode(message) {
  return String(message || '').match(/\b(CS\d+)\b/i)?.[1]?.toUpperCase() || '';
}

function normalizePluginErrors(pluginErrors) {
  const out = [];
  if (!Array.isArray(pluginErrors)) return out;
  for (const item of pluginErrors) {
    const message = normalizeMessage(typeof item === 'string' ? item : item?.message);
    if (!message) continue;
    out.push({
      message,
      code: String(item?.code || compilerCode(message)),
      source: 'unity-plugin',
      occurrences: 1,
    });
  }
  return dedupeEntries(out, MAX_COMPILE_ERRORS);
}

function extractEditorDiagnostics(logText) {
  const compile = [];
  const service = [];
  const lines = String(logText || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = normalizeMessage(raw);
    if (!line) continue;

    if (isStrongCompileError(line)) {
      compile.push({
        message: line,
        code: compilerCode(line),
        source: 'editor-log',
        occurrences: 1,
      });
      continue;
    }

    const category = classifyServiceIssue(line);
    if (category) {
      service.push({
        message: line,
        category,
        source: 'editor-log',
        occurrences: 1,
      });
    }
  }

  return {
    compile_errors: dedupeEntries(compile, MAX_COMPILE_ERRORS),
    service_issues: dedupeEntries(service, MAX_SERVICE_ISSUES),
  };
}

function mergeDeduped(a, b, maxItems) {
  return dedupeEntries([...(a || []), ...(b || [])], maxItems);
}

function totalOccurrences(entries) {
  return (entries || []).reduce((sum, item) => sum + Number(item?.occurrences || 1), 0);
}

function buildUnityDiagnostics(pluginErrors, logText) {
  const plugin = normalizePluginErrors(pluginErrors);
  const editor = extractEditorDiagnostics(logText);
  const compileErrors = mergeDeduped(plugin, editor.compile_errors, MAX_COMPILE_ERRORS);
  const serviceIssues = dedupeEntries(editor.service_issues, MAX_SERVICE_ISSUES);

  const compileErrorOccurrences = totalOccurrences(compileErrors);
  const serviceIssueOccurrences = totalOccurrences(serviceIssues);
  const licensingIssues = serviceIssues.filter(item => item.category === 'unity_licensing');

  return {
    schema_version: DIAGNOSTICS_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    project_health: compileErrors.length ? 'compile_errors' : serviceIssues.length ? 'service_issues' : 'healthy',
    compile_errors: compileErrors,
    compile_error_count: compileErrors.length,
    compile_error_occurrences: compileErrorOccurrences,
    service_issues: serviceIssues,
    service_issue_count: serviceIssues.length,
    service_issue_occurrences: serviceIssueOccurrences,
    licensing_issue_count: licensingIssues.length,
    licensing_issue_occurrences: totalOccurrences(licensingIssues),
    editor_log_redacted: true,
  };
}

function sanitizeEditorLog(logText) {
  return redactSecrets(String(logText || ''));
}

module.exports = {
  DIAGNOSTICS_SCHEMA_VERSION,
  redactSecrets,
  sanitizeEditorLog,
  isStrongCompileError,
  classifyServiceIssue,
  extractEditorDiagnostics,
  normalizePluginErrors,
  buildUnityDiagnostics,
};
