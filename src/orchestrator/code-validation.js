import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

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
      maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env,
    });
  } catch (err) {
    return { error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

async function runCmdAsync(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeout || 30000,
      maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env,
      killSignal: 'SIGKILL',
    });
    return stdout || '';
  } catch (err) {
    return { error: err.message, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function scrubbedEnv() {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    NODE_ENV: 'test',
  };
}

function isResult(err) {
  return err && typeof err === 'object' && 'error' in err;
}

function resolveDiffArgs(projectDir, { branch = null, targetBranch = null, includeLastCommit = false } = {}) {
  // Explicit two-branch comparison (e.g. campaign PR diff `main...synapse/campaign-X`):
  // works reliably regardless of which branch is currently checked out in projectDir.
  if (targetBranch && branch && targetBranch !== branch) {
    return [`${targetBranch}...${branch}`];
  }
  if (branch) {
    const current = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir });
    const currentBranch = isResult(current) ? '' : current.trim();
    if (currentBranch && currentBranch !== branch) {
      const base = runCmd('git', ['merge-base', branch, 'HEAD'], { cwd: projectDir });
      if (!isResult(base) && base.trim()) {
        // Diff merge-base against working tree (includes both committed and uncommitted changes)
        return [base.trim()];
      }
    }
  }
  const working = runCmd('git', ['diff', '--name-only', 'HEAD'], { cwd: projectDir });
  if (!isResult(working) && working.trim()) {
    return ['HEAD'];
  }
  // Only fall back to HEAD~1..HEAD when caller explicitly indicates a pre-review commit just landed
  if (includeLastCommit) {
    const hasParent = runCmd('git', ['rev-parse', '--verify', 'HEAD~1'], { cwd: projectDir });
    if (!isResult(hasParent)) {
      return ['HEAD~1', 'HEAD'];
    }
  }
  return ['HEAD'];
}

async function getChangedFiles(projectDir, diffOpts) {
  const diffTarget = resolveDiffArgs(projectDir, diffOpts);
  const result = runCmd('git', ['diff', '--name-only', ...diffTarget], { cwd: projectDir });
  if (isResult(result)) return [];
  return result.trim().split('\n').filter(Boolean);
}

async function getDiffContent(projectDir, diffOpts) {
  const diffTarget = resolveDiffArgs(projectDir, diffOpts);
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
  const {
    branch = null,
    targetBranch = null,
    includeLastCommit = false,
    runTests = false,
    runLint = false,
    verifyCmd = null,
    verifyTimeoutMs = 180000,
  } = options;
  const diffOpts = { branch, targetBranch, includeLastCommit };
  const report = {};
  const explicitVerifyCmd = (typeof verifyCmd === 'string' && verifyCmd.trim()) ? verifyCmd.trim() : null;

  const changedFiles = await getChangedFiles(projectDir, diffOpts);
  report.filesChanged = changedFiles.length;
  report.changedFiles = changedFiles;

  if (changedFiles.length === 0 && !explicitVerifyCmd) {
    report.syntax = { pass: true, files: 0, errors: [] };
    report.security = { pass: true, issues: [] };
    report.scope = { pass: true, outOfScopeFiles: [], configTouched: [], configTouchedCount: 0 };
    report.stats = { added: 0, removed: 0, filesChanged: 0 };
    report.tests = { pass: true, skipped: true, reason: 'no changes' };
    report.lint = { pass: true, skipped: true, reason: 'no changes' };
    report.verify = { pass: true, skipped: true, reason: 'no changes' };
    report.ran = { syntax: false, security: false, scope: false, tests: false, lint: false, verify: false };
    report.overallPass = true;
    return report;
  }

  report.syntax = changedFiles.length > 0 ? checkSyntax(projectDir, changedFiles) : { pass: true, files: 0, errors: [] };

  const diffContent = changedFiles.length > 0 ? await getDiffContent(projectDir, diffOpts) : '';
  report.security = changedFiles.length > 0 ? checkSecurity(diffContent) : { pass: true, issues: [] };
  report.scope = changedFiles.length > 0 ? checkScope(changedFiles) : { pass: true, outOfScopeFiles: [], configTouched: [], configTouchedCount: 0 };
  report.stats = changedFiles.length > 0 ? checkDiffStats(diffContent) : { added: 0, removed: 0, filesChanged: 0 };

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

  // Never auto-execute agent-writable ./verify files. Run ONLY an explicit
  // operator-configured verifyCmd, asynchronously, with a scrubbed environment,
  // and only after static syntax/security/scope gates are clean.
  const staticChecksOk = report.syntax.pass && report.security.pass && report.scope.pass;
  if (explicitVerifyCmd && staticChecksOk) {
    const vRes = await runCmdAsync('bash', ['-c', explicitVerifyCmd], {
      cwd: projectDir,
      timeout: verifyTimeoutMs,
      env: scrubbedEnv(),
    });
    if (isResult(vRes)) {
      const combined = [vRes.stdout, vRes.stderr, vRes.error].filter(Boolean).join('\n').slice(0, 1500);
      report.verify = { pass: false, ran: true, command: explicitVerifyCmd, output: combined };
    } else {
      report.verify = { pass: true, ran: true, command: explicitVerifyCmd, output: String(vRes || '').slice(0, 500) };
    }
  } else if (explicitVerifyCmd && !staticChecksOk) {
    report.verify = { pass: false, ran: false, skipped: true, command: explicitVerifyCmd, reason: 'blocked by static syntax/security/scope failure' };
  } else {
    report.verify = { pass: true, ran: false, skipped: true, reason: 'no verifyCmd' };
  }

  report.ran = {
    syntax: changedFiles.length > 0,
    security: changedFiles.length > 0,
    scope: changedFiles.length > 0,
    tests: !report.tests.skipped,
    lint: !report.lint.skipped,
    verify: Boolean(report.verify.ran),
  };

  report.overallPass = Boolean(
    report.syntax.pass &&
    report.security.pass &&
    report.scope.pass &&
    report.tests.pass !== false &&
    report.lint.pass !== false &&
    report.verify.pass !== false
  );

  log.info('Validation pipeline complete', {
    files: report.stats.filesChanged,
    added: report.stats.added,
    removed: report.stats.removed,
    syntax: report.syntax.pass,
    security: report.security.pass,
    scope: report.scope.pass,
    tests: report.tests.pass,
    lint: report.lint.pass,
    verify: report.verify.pass,
    configTouched: report.scope.configTouchedCount,
    overall: report.overallPass,
  });

  return report;
}
