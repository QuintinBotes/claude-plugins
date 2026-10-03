// Test fixtures: a temp config and terms file (via PUBLISH_GUARD_CONFIG), a
// hermetic git environment that ignores the user's own git config, and repos
// whose remotes point at GitHub URLs that are never contacted.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/publish-guard', import.meta.url));

// Placeholder terms only. Real terms never belong in this repository.
export const TERMS = ['# test terms', '', 'acme-internal', 'AcmeWidget', 're:acme[ ._]corp', ''].join('\n');
export const TERM_WORDS = ['acme-internal', 'acmewidget', 'acme corp', 'acme.corp', 'acme_corp'];

// The repository's own publish-guard CI flags real-looking addresses in added
// lines, so fixtures use a reserved domain or are assembled at runtime.
export const ME = 'me@personal.example';
export const WORK = ['dev', 'corp-mail.io'].join('@');

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'pg-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function setup({ owners = ['octo-owner'], emails = [ME], terms = TERMS } = {}) {
  const home = tempDir('pg-home-');
  const termsFile = join(home, 'terms.txt');
  writeFileSync(termsFile, terms);
  const configPath = join(home, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      protected_owners: owners,
      allowed_emails: emails,
      allowed_email_patterns: ['@users\\.noreply\\.github\\.com$', '^noreply@github\\.com$', '@example\\.(com|org|net)$', '^noreply@anthropic\\.com$'],
      terms_file: termsFile,
    }),
  );
  const gitconfig = join(home, '.gitconfig');
  writeFileSync(
    gitconfig,
    ['[user]', `\tname = Test User`, `\temail = ${ME}`, '[commit]', '\tgpgsign = false', '[tag]', '\tgpgsign = false', '[init]', '\tdefaultBranch = main', ''].join('\n'),
  );
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GIT_|PUBLISH_GUARD_|EMAIL$)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    PUBLISH_GUARD_CONFIG: configPath,
    PUBLISH_GUARD_NO_SSH_LOOKUP: '1',
  });
  return { home, termsFile, configPath, env };
}

export function git(cwd, env, ...args) {
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

export function makeRepo(env, { remote = 'https://github.com/octo-owner/project.git' } = {}) {
  const dir = tempDir('pg-repo-');
  git(dir, env, 'init', '-q');
  if (remote) git(dir, env, 'remote', 'add', 'origin', remote);
  return dir;
}

export function commit(dir, env, file, content, message, extraEnv = {}) {
  writeFileSync(join(dir, file), content);
  git(dir, env, 'add', file);
  const res = spawnSync('git', ['commit', '-q', '--no-verify', '-m', message], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
  return git(dir, env, 'rev-parse', 'HEAD');
}

export function run(args, { env, cwd, input } = {}) {
  const started = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [BIN, ...args], { env, cwd, input, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, ms };
}

// Runs the Claude Code hook the way Claude Code does: PreToolUse JSON on
// stdin. Returns { deny, reason, raw, ms }.
export function claudeHook(command, { env, cwd, tool = 'Bash', toolInput } = {}) {
  const input = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: tool,
    tool_input: toolInput ?? { command },
  });
  const res = run(['hook', 'claude'], { env, cwd, input });
  let parsed = null;
  if (res.stdout.trim()) parsed = JSON.parse(res.stdout);
  const out = parsed?.hookSpecificOutput;
  return {
    code: res.code,
    deny: out?.permissionDecision === 'deny',
    allowField: out?.permissionDecision === 'allow',
    reason: out?.permissionDecisionReason ?? '',
    raw: res.stdout + res.stderr,
    ms: res.ms,
    parsed,
  };
}

export function containsTerm(text) {
  const lower = text.toLowerCase();
  return TERM_WORDS.some((t) => lower.includes(t));
}
