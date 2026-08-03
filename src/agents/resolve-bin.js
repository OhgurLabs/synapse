// resolve-bin.js — Locate a CLI binary's absolute path at module import time.
//
// Synapse's auto-detect created agents with bare wrapper names like
// 'claudecode', 'codex', 'gemini' for cliPath. Worked when the user ran
// `synapse start` from an interactive shell that had ~/.local/bin on PATH —
// failed on every fresh beta install because the spawn child process'
// PATH doesn't include the user's npm-global bin dir (npm config get prefix
// = ~/.local, not on PATH for headless / systemd / nohup launches).
//
// resolveBinary(candidates) walks the candidate list and returns the first
// one that `which` resolves. If none resolve, falls back to the first
// candidate as-is so legacy behavior is preserved on systems where the
// binary truly isn't installed yet (the failure will then surface as a
// clear ENOENT instead of being hidden).
//
// The resolved path is computed once per process (at module-import time of
// the agent class) and persisted via saveAgentsConfig — so subsequent
// restarts load the absolute path from disk and don't re-resolve.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Common install locations to check directly before falling back to `which`.
// Order matters: user-local installs (npm-global, pipx, etc.) take precedence
// over system installs because that's where harness CLIs typically land.
function commonDirs() {
  const home = homedir();
  return [
    join(home, '.local/bin'),                  // npm/pip user-local
    join(home, '.bun/bin'),                    // bun-installed
    join(home, '.cargo/bin'),                  // cargo-installed
    join(home, '.nvm/current/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',                       // macOS arm64 brew
    '/usr/local/opt',
    '/usr/bin',
    '/bin',
  ];
}

/**
 * Resolve a binary by candidate name(s). Optionally accepts a list of
 * `knownPaths` (descriptor-supplied absolute or `~/...`-style paths to specific
 * binary files) that are tested FIRST, before commonDirs and `which`.
 * This is the BYOH fix: a descriptor declares where its binary lives
 * (e.g. `~/.grok/bin/grok`), and resolveBinary respects that hint without
 * needing the binary to be on PATH.
 */
export function resolveBinary(candidates, knownPaths = []) {
  // 0. Descriptor-supplied known paths win. These are specific binary files,
  //    not directories. Expand `~/` and existsSync each one.
  const home = homedir();
  for (const raw of (knownPaths || [])) {
    if (!raw || typeof raw !== 'string') continue;
    const expanded = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
    try { if (existsSync(expanded)) return expanded; } catch (_) {}
  }

  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const name of list) {
    if (!name) continue;
    // Already absolute — trust the caller.
    if (name.startsWith('/')) return name;

    // 1. Direct filesystem checks at common install paths. This is the
    //    reliable path: synapse's child-process env often lacks the user's
    //    PATH augmentations (~/.local/bin is added via .bashrc / .profile,
    //    not inherited by systemd / nohup launches), so `which` can fail
    //    even when the binary plainly exists on disk.
    for (const dir of commonDirs()) {
      const candidate = join(dir, name);
      try { if (existsSync(candidate)) return candidate; } catch (_) {}
    }

    // 2. Fall back to `which` for cases where the binary is in a custom
    //    path the user explicitly added to PATH before launching synapse.
    try {
      const result = execFileSync('which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const path = result.trim();
      if (path && path.startsWith('/')) return path;
    } catch (_) {
      // `which` returned non-zero — try next candidate.
    }
  }
  // None resolved — fall back to first name as-is. The eventual spawn ENOENT
  // is a clearer signal than silently using a different binary.
  return list[0];
}
