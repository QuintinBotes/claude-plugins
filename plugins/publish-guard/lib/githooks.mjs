// The git layer: pre-commit, commit-msg and pre-push hooks, and their
// installer. These catch what Claude Code never sees: commits made by hand,
// by an IDE, or by a script that calls git itself.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProtectedOwner, loadConfig, redactLoaded, scannerFor } from './config.mjs';
import * as G from './git.mjs';
import { dedupe, formatReport } from './scan.mjs';
import { GuardError } from './util.mjs';

export const HOOK_NAMES = ['pre-commit', 'commit-msg', 'pre-push'];
const MARKER = 'publish-guard managed hook';

function fail(err, io) {
  io.err(`publish-guard: ${err instanceof GuardError ? redactLoaded(err.message) : 'unexpected error'}; refusing to continue unchecked.`);
  return 1;
}

function block(hook, target, findings, scanner, io) {
  const lines = formatReport(dedupe(findings), scanner, { limit: 50 });
  io.err(`publish-guard: ${hook} blocked for ${target} (protected owner):`);
  for (const l of lines) io.err(`  ${l}`);
  io.err('Remove the private text (███ marks each match; terms are never printed) or fix the identity, then retry.');
  return 1;
}

function load(io, env) {
  const config = loadConfig({ env });
  if (config.missing) {
    io.err(`publish-guard: no config at ${config.path}; nothing is protected. Run publish-guard init.`);
    return null;
  }
  return config;
}

function describe(info, env) {
  const t = G.repoTargets(info, env)[0];
  return t ? `${t.owner}/${t.repo}` : info.dir;
}

// git strips comment lines and everything below the scissors line before
// storing the message, so those parts are not published.
function cleanMessage(text, commentChar) {
  const scissors = text.search(new RegExp(`^\\${commentChar} -+ >8 -+$`, 'm'));
  if (scissors !== -1) text = text.slice(0, scissors);
  return text
    .split('\n')
    .filter((l) => !l.startsWith(commentChar))
    .join('\n');
}

export function readCommitMessage(file, dir, env) {
  const raw = readFileSync(file, 'utf8');
  let cc = G.git(['config', '--get', 'core.commentChar'], { cwd: dir, env, allowFail: true })?.trim() || '#';
  if (cc === 'auto') cc = '#';
  return cleanMessage(raw, cc[0]);
}

export function runGitHook(hook, args, { env = process.env, cwd = process.cwd(), stdin = '', io }) {
  try {
    const config = load(io, env);
    if (!config) return 0;
    const genv = G.gitEnv(env);
    const info = G.repoInfo(cwd, { env: genv });
    if (!info) return 0;

    if (hook === 'pre-commit' || hook === 'commit-msg') {
      if (!G.repoIsProtected(info, config, genv)) return 0;
      const s = scannerFor(config);
      let findings;
      if (hook === 'pre-commit') {
        findings = G.scanDiffFiles(s, G.stagedDiff(cwd, { env: genv }), 'staged ');
        findings.push(...G.scanIdentities(s, G.effectiveIdentities(cwd, { env: genv }), 'commit '));
      } else {
        if (!args[0]) throw new GuardError('commit-msg needs the message file argument');
        findings = s.message(readCommitMessage(args[0], cwd, genv), 'commit message');
      }
      return findings.length ? block(hook, describe(info, genv), findings, s, io) : 0;
    }

    if (hook === 'pre-push') {
      const [remote, url] = args;
      const owners = G.ownersOf([url ?? ''], genv);
      if (!info.forceProtect && !owners.some((o) => isProtectedOwner(config, o.owner))) return 0;
      const s = scannerFor(config);
      const named = remote && info.remotes.has(remote) ? remote : null;
      const exclude = named ? [`--remotes=${named}`] : [];
      const findings = [];
      for (const line of stdin.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const [localRef, localSha, , remoteSha] = parts;
        if (G.ZERO_SHA.test(localSha)) continue;
        if (localRef.startsWith('refs/tags/') && G.objectType(cwd, localSha, genv) === 'tag') {
          findings.push(...G.scanTagObject(s, cwd, localSha, localRef.slice(10), genv));
        }
        const not = [...exclude];
        // The remote's old tip is only usable when we have it locally (it
        // may come from someone else's push we never fetched).
        if (!G.ZERO_SHA.test(remoteSha) && G.objectType(cwd, remoteSha, genv)) not.push(remoteSha);
        findings.push(...G.scanCommits(s, cwd, [localSha, ...(not.length ? ['--not', ...not] : [])], { env: genv }).findings);
      }
      const where = owners[0] ? `${owners[0].owner}/${owners[0].repo}` : describe(info, genv);
      return findings.length ? block(hook, where, findings, s, io) : 0;
    }
    throw new GuardError(`unknown git hook ${hook}`);
  } catch (err) {
    return fail(err, io);
  }
}

// --- Installer -------------------------------------------------------------------

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function hookScript(name, binPath, nodePath) {
  const head = [
    '#!/bin/sh',
    `# ${MARKER}. Re-run \`publish-guard install-git-hooks\` to update it.`,
    `# A hook that was here before was kept as ${name}.local and runs after the guard.`,
    'guard=${PUBLISH_GUARD_BIN:-}',
    `[ -n "$guard" ] || guard=${shQuote(binPath)}`,
    'node=${PUBLISH_GUARD_NODE:-}',
    `[ -n "$node" ] || node=${shQuote(nodePath)}`,
    '[ -x "$node" ] || node=node',
    'if [ ! -f "$guard" ]; then',
    '  echo "publish-guard: $guard is missing (plugin moved or updated?). Re-run publish-guard install-git-hooks; refusing to continue unchecked." >&2',
    '  exit 1',
    'fi',
    `local_hook="$(dirname "$0")/${name}.local"`,
  ];
  if (name === 'pre-push') {
    // pre-push gets the ref list on stdin, and both hooks need it.
    return [
      ...head,
      'input=$(mktemp "${TMPDIR:-/tmp}/publish-guard.XXXXXX") || exit 1',
      "trap 'rm -f \"$input\"' EXIT",
      'cat > "$input"',
      `"$node" "$guard" hook git ${name} "$@" < "$input" || exit $?`,
      'if [ -x "$local_hook" ]; then',
      '  "$local_hook" "$@" < "$input"',
      '  exit $?',
      'fi',
      'exit 0',
      '',
    ].join('\n');
  }
  return [
    ...head,
    `"$node" "$guard" hook git ${name} "$@" || exit $?`,
    'if [ -x "$local_hook" ]; then exec "$local_hook" "$@"; fi',
    'exit 0',
    '',
  ].join('\n');
}

export function installGitHooks(repo, { env = process.env, binPath, nodePath = process.execPath, io }) {
  const genv = G.gitEnv(env);
  const info = G.repoInfo(repo, { env: genv });
  if (!info) {
    io.err(`publish-guard: ${repo} is not a git repository`);
    return 2;
  }
  const origin = G.git(['config', '--show-origin', '--get', 'core.hooksPath'], { cwd: repo, env: genv, allowFail: true });
  if (origin) {
    const [where, value] = origin.trim().split('\t');
    io.err(`publish-guard: core.hooksPath is set to ${value} (${where}), so git ignores .git/hooks and nothing was installed.`);
    io.err('Either remove that setting, or add these lines near the top of the hooks in that directory:');
    for (const name of HOOK_NAMES) {
      const args = name === 'commit-msg' ? '"$1"' : name === 'pre-push' ? '"$@" (pass the same stdin through)' : '';
      io.err(`  ${name}: ${shQuote(nodePath)} ${shQuote(binPath)} hook git ${name} ${args}`.trimEnd());
    }
    return 2;
  }
  const dir = G.hooksDir(repo, genv);
  mkdirSync(dir, { recursive: true });
  let status = 0;
  for (const name of HOOK_NAMES) {
    const path = join(dir, name);
    const script = hookScript(name, binPath, nodePath);
    if (existsSync(path)) {
      const current = readFileSync(path, 'utf8');
      if (current.includes(MARKER)) {
        writeFileSync(path, script);
        chmodSync(path, 0o755);
        io.out(`updated ${path}`);
        continue;
      }
      if (existsSync(`${path}.local`)) {
        io.err(`publish-guard: ${path} and ${path}.local both exist; merge them by hand, then re-run. Skipped ${name}.`);
        status = 2;
        continue;
      }
      renameSync(path, `${path}.local`);
      io.out(`kept the existing ${name} hook as ${name}.local; it runs after the guard`);
    }
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    io.out(`installed ${path}`);
  }
  return status;
}
