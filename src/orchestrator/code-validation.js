import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('code-validation');

const SECRET_PATTERNS = [
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}/i,
  /sk-[a-zA-Z0-9]{20,}/,
  /AIzaSy[a-zA-Z0-9_-]{33}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /xox[bpors]-[a-zA-Z0-9-]+/,
];

function runCmd(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout || 30000,
      cwd: opts.cwd,
    });
  } catch (err) {
    return { error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function isResult(err) {
  return err && typeof err === 'object' && 'error' in err;
}

async function getChangedFiles(projectDir, branch) {
  let diffTarget = ['--name-only', 'HEAD'];
  if (branch) {
    const base = runCmd('git', ['merge-base', branch, 'HEAD'], { cwd: projectDir });
    if (!isResult(base)) {
      diffTarget = ['--name-only', base.trim()];
    }
  }
  const result = runCmd('git', ['diff', ...diffTarget], { cwd: projectDir });
  if (isResult(result)) return [];
  return result.trim().split('\n').filter(Boolean);
}

async function getDiffContent(projectDir, branch) {
  let diffTarget = ['HEAD'];
  if (branch) {
    const base = runCmd('git', ['merge-base', branch, 'HEAD'], { cwd: projectDir });
    if (!isResult(base)) {
      diffTarget = [base.trim()];
    }
  }
  const result = runCmd('git', ['diff', ...diffTarget], { cwd: projectDir, timeout: 60000 });
  if (isResult(result)) return '';
  return result;
}

function checkSyntax(projectDir, changedFiles) {
  const jsFiles = changedFiles.filter(f => f.endsWith('.js') && existsSync(join(projectDir, f)));
  const results = { pass: true, files: jsFiles.length, errors: [] };
  for (const file of jsFiles) {
    const result = runCmd('node', ['--check', join(projectDir, file)], { cwd: projectDir });
    if (isResult(result)) {
      results.pass = false;
      results.errors.push({ file, error: result.stderr?.slice(0, 200) || result.error });
    }
  }
  return results;
}

function checkSecurity(diffContent) {
  const results = { pass: true, issues: [] };
  const lines = diffContent.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of lines) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        const cleaned = line.slice(1).trim().slice(0, 120);
        results.pass = false;
        results.issues.push(cleaned);
      }
    }
  }
  return results;
}

function checkScope(changedFiles) {
  const configPatterns = ['.env', 'agents.json', 'config.json', 'settings.json'];
  const outOfScope = changedFiles.filter(f =>
    f.startsWith('..') || f.startsWith('/'));
  const configTouched = changedFiles.filter(f =>
    configPatterns.some(p => f.endsWith(p)));
  return {
    pass: outOfScope.length === 0,
    outOfScopeFiles: outOfScope,
    configTouched: configTouched,
    configTouchedCount: configTouched.length,
  };
}

function checkDiffStats(diffContent) {
  let added = 0;
  let removed = 0;
  const files = new Set();
  for (const line of diffContent.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    if (line.startsWith('+++')) files.add(line.slice(6).trim());
  }
  return { added, removed, filesChanged: files.size };
}

export async function runValidationPipeline(projectDir, options = {}) {
  const { branch = null, runTests = false, runLint = false } = options;
  const report = {};

  const changedFiles = await getChangedFiles(projectDir, branch);
  report.filesChanged = changedFiles.length;
  report.changedFiles = changedFiles;

  if (changedFiles.length === 0) {
    report.syntax = { pass: true, files: 0, errors: [] };
    report.security = { pass: true, issues: [] };
    report.scope = { pass: true, outOfScopeFiles: [], configTouched: [], configTouchedCount: 0 };
    report.stats = { added: 0, removed: 0, filesChanged: 0 };
    report.tests = { pass: true, skipped: true, reason: 'no changes' };
    report.lint = { pass: true, skipped: true, reason: 'no changes' };
    report.overallPass = true;
    return report;
  }

  report.syntax = checkSyntax(projectDir, changedFiles);

  const diffContent = await getDiffContent(projectDir, branch);
  report.security = checkSecurity(diffContent);
  report.scope = checkScope(changedFiles);
  report.stats = checkDiffStats(diffContent);

  if (runTests) {
    const pkgPath = join(projectDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const testScript = pkg.scripts?.test;
      if (testScript && testScript !== 'echo \"Error: no test specified\" && exit 1') {
        const result = runCmd('npm', ['test'], { cwd: projectDir, timeout: 120000 });
        if (isResult(result)) {
          report.tests = { pass: false, output: (result.stderr || result.error || '').slice(0, 500) };
        } else {
          report.tests = { pass: true, output: result.slice(0, 200) };
        }
      } else {
        report.tests = { pass: true, skipped: true, reason: 'no test script' };
      }
    } else {
      report.tests = { pass: true, skipped: true, reason: 'no package.json' };
    }
  } else {
    report.tests = { pass: true, skipped: true, reason: 'disabled' };
  }

  if (runLint) {
    const pkgPath = join(projectDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.lint) {
        const result = runCmd('npm', ['run', 'lint'], { cwd: projectDir, timeout: 60000 });
        if (isResult(result)) {
          report.lint = { pass: false, output: (result.stderr || result.error || '').slice(0, 500) };
        } else {
          report.lint = { pass: true, output: result.slice(0, 200) };
        }
      } else {
        report.lint = { pass: true, skipped: true, reason: 'no lint script' };
      }
    } else {
      report.lint = { pass: true, skipped: true, reason: 'no package.json' };
    }
  } else {
    report.lint = { pass: true, skipped: true, reason: 'disabled' };
  }

  report.overallPass = report.syntax.pass && report.security.pass && report.scope.pass;

  log.info('Validation pipeline complete', {
    files: report.stats.filesChanged,
    added: report.stats.added,
    removed: report.stats.removed,
    syntax: report.syntax.pass,
    security: report.security.pass,
    scope: report.scope.pass,
    configTouched: report.scope.configTouchedCount,
    overall: report.overallPass,
  });

  return report;
}
