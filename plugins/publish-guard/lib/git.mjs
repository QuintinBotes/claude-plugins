// Git plumbing for the scanner: repository facts (remotes, owners), staged
// and per-commit added lines, identities and tag messages. Output formats are
// pinned with -c flags so a user's git config cannot change what is parsed.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { isProtectedOwner } from './config.mjs';
import { parseGitHubUrl } from './github.mjs';
import { GuardError, readTextFile } from './util.mjs';

const PINNED = [
  '-c', 'core.quotePath=false',
  '-c', 'color.ui=false',
  '-c', 'log.showSignature=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'core.pager=cat',
  '-c', 'core.attributesFile=/dev/null',
];

export const ZERO_SHA = /^0+$/;

// Environment for git children. Hooks must never prompt or take the index
// lock (GIT_OPTIONAL_LOCKS=0), and must not fetch.
export function gitEnv(base = process.env, extra = {}) {
  return { ...base, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', ...extra };
}

// The Claude Code hook has a time limit, and a hook that runs out of time
// lets the command through. It sets a deadline below that limit; a git call
// that would run past it is stopped with a GuardError, which denies.
let deadline = Infinity;

export function setDeadline(at) {
  deadline = at;
}

export function git(args, { cwd, env = gitEnv(), input, allowFail = false } = {}) {
  const left = deadline - Date.now();
  const tooSlow = () => new GuardError('checking took longer than the Claude Code hook may run; publish from a terminal with the publish-guard git hooks installed, which have no time limit');
  if (left <= 0) throw tooSlow();
  const res = spawnSync('git', [...PINNED, ...args], {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    timeout: Number.isFinite(left) ? left : undefined,
  });
  // A timed-out call must not read as "not a repository" (allowFail).
  if (Number.isFinite(left) && (res.error?.code === 'ETIMEDOUT' || (res.signal && Date.now() >= deadline))) throw tooSlow();
  if (res.error) {
    if (allowFail) return null;
    throw new GuardError(`git ${args[0]} could not run: ${res.error.code ?? res.error.message}`);
  }
  if (res.status !== 0) {
    if (allowFail) return null;
    const first = (res.stderr || '').trim().split('\n')[0];
    throw new GuardError(`git ${args[0]} failed: ${first}`);
  }
  return res.stdout;
}

// --- Repository facts -------------------------------------------------------

function parseConfigZ(out) {
  const map = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl === -1 ? rec : rec.slice(0, nl);
    const value = nl === -1 ? 'true' : rec.slice(nl + 1);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function rewrite(url, rules) {
  let best = null;
  for (const r of rules) if (url.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  return best ? best.base + url.slice(best.prefix.length) : url;
}

// One rev-parse and one config read: enough to answer every owner question
// a hook asks, and cheap enough to run on every publishing command.
export function repoInfo(dir, { env = gitEnv() } = {}) {
  const rp = git(['rev-parse', '--absolute-git-dir', '--is-bare-repository'], { cwd: dir, env, allowFail: true });
  if (rp === null) return null;
  const [gitDir, bare] = rp.trim().split('\n');
  const cfgOut =
    git(['config', '-z', '--get-regexp', '^(remote|url|branch|publish-guard)\\.|^push\\.(default|followtags)$|^core\\.hookspath$'], {
      cwd: dir,
      env,
      allowFail: true,
    }) ?? '';
  const config = parseConfigZ(cfgOut);
  const insteadOf = [];
  const pushInsteadOf = [];
  const remotes = new Map();
  for (const [key, values] of config) {
    let m = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(key);
    if (m) {
      for (const prefix of values) (m[2] === 'insteadof' ? insteadOf : pushInsteadOf).push({ base: m[1], prefix });
      continue;
    }
    m = /^remote\.(.+)\.(url|pushurl|gh-resolved)$/.exec(key);
    if (m) {
      if (!remotes.has(m[1])) remotes.set(m[1], { name: m[1], urls: [], pushUrls: [], ghResolved: null });
      const r = remotes.get(m[1]);
      if (m[2] === 'url') r.urls.push(...values);
      else if (m[2] === 'pushurl') r.pushUrls.push(...values);
      else r.ghResolved = values[values.length - 1];
    }
  }
  for (const r of remotes.values()) {
    r.fetchUrls = r.urls.map((u) => rewrite(u, insteadOf));
    r.resolvedPushUrls = r.pushUrls.length
      ? r.pushUrls.map((u) => rewrite(u, insteadOf))
      : r.urls.map((u) => {
          const pushed = rewrite(u, pushInsteadOf);
          return pushed !== u ? pushed : rewrite(u, insteadOf);
        });
  }
  const get = (key) => config.get(key)?.at(-1);
  return {
    dir,
    gitDir,
    bare: bare === 'true',
    remotes,
    get,
    getAll: (key) => config.get(key) ?? [],
    insteadOf,
    pushInsteadOf,
    forceProtect: /^(true|yes|on|1)$/i.test(get('publish-guard.protect') ?? ''),
    rewritePush(url) {
      const pushed = rewrite(url, pushInsteadOf);
      return pushed !== url ? pushed : rewrite(url, insteadOf);
    },
  };
}

export function ownersOf(urls, env) {
  return urls.map((u) => parseGitHubUrl(u, env)).filter(Boolean);
}

// Owners a repository could publish to: every remote, fetch and push URL.
// A repository with a protected remote anywhere is treated as protected,
// because a commit made in it can end up on any of them.
export function repoTargets(info, env) {
  const all = [];
  for (const r of info.remotes.values()) all.push(...ownersOf([...r.fetchUrls, ...r.resolvedPushUrls], env));
  return all;
}

export function repoIsProtected(info, config, env) {
  if (!info) return false;
  if (info.forceProtect) return true;
  return repoTargets(info, env).some((t) => isProtectedOwner(config, t.owner));
}

export function currentBranch(dir, env) {
  const out = git(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: dir, env, allowFail: true });
  return out ? out.trim() : null;
}

// The remote `git push` with no repository argument uses.
export function defaultPushRemote(info, branch) {
  if (branch) {
    const pr = info.get(`branch.${branch}.pushremote`);
    if (pr) return pr;
  }
  const pd = info.get('remote.pushdefault');
  if (pd) return pd;
  if (branch) {
    const r = info.get(`branch.${branch}.remote`);
    if (r) return r;
  }
  return 'origin';
}

// --- Diffs ------------------------------------------------------------------

function unquotePath(p) {
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p.replace(/\\([0-7]{3})/g, (_, o) => `\\u00${parseInt(o, 8).toString(16).padStart(2, '0')}`));
  } catch {
    return p.slice(1, -1);
  }
}

// Parses a -U0 unified diff into added lines and the paths it touches.
// Paths are scanned too: a file or directory named after a client is a leak.
export function parseDiff(patch) {
  const files = [];
  let cur = null;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = { path: m ? unquotePath(m[2]) : line.slice(11), added: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') cur.path = unquotePath(p).replace(/^b\//, '');
      } else if (line.startsWith('rename to ')) {
        cur.path = unquotePath(line.slice(10));
      } else if (line.startsWith('copy to ')) {
        cur.path = unquotePath(line.slice(8));
      } else if (line.startsWith('deleted file mode')) {
        cur.deleted = true;
      }
    }
    if (line.startsWith('@@')) {
      const m = /^@@+ (?:-\S+ )+\+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      cur.added.push({ line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return files;
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/'];

// A committed .gitattributes can mark text files `binary` or `-diff`, which
// turns their diff into "Binary files differ" and hides every added line.
// Reading attributes from the empty tree instead (GIT_ATTR_SOURCE, git 2.42+;
// older git ignores it) leaves only git's own content check, the same NUL
// test the audit uses. core.attributesFile is pinned to /dev/null above.
const emptyTrees = new Map();

function diffEnv(dir, env) {
  let tree = emptyTrees.get(dir);
  if (tree === undefined) {
    tree = git(['hash-object', '-t', 'tree', '/dev/null'], { cwd: dir, env, allowFail: true })?.trim() || null;
    emptyTrees.set(dir, tree);
  }
  return tree ? { ...env, GIT_ATTR_SOURCE: tree } : env;
}

export function scanDiffFiles(scanner, files, wherePrefix) {
  const findings = [];
  for (const f of files) {
    if (f.deleted) continue;
    const label = `${wherePrefix}${f.path}`;
    findings.push(...scanner.text(f.path, `${label} (path)`, { emails: 'none', numbered: false }));
    // Consecutive added lines are scanned as one block, so a term wrapped
    // onto the next line is still found.
    for (let i = 0; i < f.added.length; ) {
      let j = i + 1;
      while (j < f.added.length && f.added[j].line === f.added[j - 1].line + 1) j++;
      const block = f.added.slice(i, j).map((a) => a.text).join('\n');
      findings.push(...scanner.text(block, label, { emails: 'content', lineBase: f.added[i].line - 1 }));
      i = j;
    }
  }
  return findings;
}

// Staged changes: what `git commit` would record. `paths` narrows to a
// pathspec; `all` mirrors `git commit -a`.
export function stagedDiff(dir, { env, all = false, paths = null } = {}) {
  const args = ['diff', ...DIFF_FLAGS];
  if (all || paths) {
    if (!hasHead(dir, env)) args.push('--cached');
    else args.push('HEAD');
  } else {
    args.push('--cached');
  }
  if (paths?.length) args.push('--', ...paths);
  return parseDiff(git(args, { cwd: dir, env: diffEnv(dir, env) }));
}

export function hasHead(dir, env) {
  return git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: dir, env, allowFail: true }) !== null;
}

// Untracked, non-ignored files (optionally under `paths`): `git add -A &&
// git commit` in one Bash call stages them after the hook has run.
export function untrackedFiles(dir, { env, paths = null } = {}) {
  const out = git(['ls-files', '-z', '--others', '--exclude-standard', ...(paths?.length ? ['--', ...paths] : [])], {
    cwd: dir,
    env,
  });
  const files = [];
  let budget = 32 * 1024 * 1024;
  for (const rel of out.split('\0').filter(Boolean)) {
    const res = readTextFile(join(dir, rel));
    if (!res.text) {
      files.push({ path: rel, added: [] });
      continue;
    }
    budget -= res.text.length;
    if (budget < 0) throw new GuardError('untracked files are too large to check in one pass; stage and commit them in smaller steps');
    files.push({ path: rel, added: res.text.split('\n').map((text, i) => ({ line: i + 1, text })) });
  }
  return files;
}

export function topLevel(dir, env) {
  const out = git(['rev-parse', '--show-toplevel'], { cwd: dir, env, allowFail: true });
  return out ? out.trim() : null;
}

// --- Identities ---------------------------------------------------------------

export function parseIdent(ident) {
  const m = /^(.*?)\s*<([^>]*)>/.exec(ident ?? '');
  return m ? { name: m[1], email: m[2] } : { name: ident ?? '', email: '' };
}

// The author and committer `git commit` would use right now, honouring
// GIT_AUTHOR_* / GIT_COMMITTER_* / EMAIL in `env` and `-c user.email=...`.
export function effectiveIdentities(dir, { env, configArgs = [] } = {}) {
  const read = (v) => {
    const res = spawnSync('git', [...configArgs, 'var', v], { cwd: dir, env, encoding: 'utf8' });
    if (res.status !== 0) {
      return { error: (res.stderr || '').trim().split('\n').find((l) => /fatal|error/i.test(l)) ?? `git var ${v} failed` };
    }
    return parseIdent(res.stdout.trim());
  };
  return { author: read('GIT_AUTHOR_IDENT'), committer: read('GIT_COMMITTER_IDENT') };
}

export function scanIdentities(scanner, ids, wherePrefix = '') {
  const findings = [];
  for (const [role, id] of Object.entries(ids)) {
    if (!id) continue;
    const where = `${wherePrefix}${role}`;
    if (id.error) findings.push({ kind: 'error', where, message: `cannot determine identity (${id.error})` });
    else findings.push(...scanner.identity(id.name, id.email, where));
  }
  return findings;
}

// --- Commit ranges -------------------------------------------------------------

const RS = '\x1e';
const US = '\x1f';
const LOG_FORMAT = `--format=${RS}%H${US}%an${US}%ae${US}%cn${US}%ce${US}%B${US}`;

let remergeSupported = null;

// remerge-diff (git 2.36+) shows what a merge commit itself introduced:
// conflict resolutions and "evil merges". Plain -p shows nothing for merges.
function supportsRemerge(env) {
  if (remergeSupported === null) {
    const m = /(\d+)\.(\d+)/.exec(git(['version'], { env, allowFail: true }) ?? '');
    remergeSupported = Boolean(m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 36)));
  }
  return remergeSupported;
}

// Messages, identities and added lines of every commit in `revs` (git rev
// list syntax, e.g. [sha, '--not', '--remotes=origin']).
export function scanCommits(scanner, dir, revs, { env, withPatch = true } = {}) {
  for (const r of revs) {
    if (typeof r !== 'string' || (r.startsWith('-') && r !== '--not' && !/^--(remotes|branches|tags|all)(=.*)?$/.test(r))) {
      throw new GuardError('refusing an option-like revision argument');
    }
  }
  const args = ['log', LOG_FORMAT];
  if (withPatch) {
    args.push('-p', ...DIFF_FLAGS);
    if (supportsRemerge(env)) args.push('--diff-merges=remerge');
  }
  const out = git([...args, ...revs], { cwd: dir, env: withPatch ? diffEnv(dir, env) : env });
  const findings = [];
  let commits = 0;
  for (const rec of out.split(RS)) {
    if (!rec) continue;
    const parts = rec.split(US);
    if (parts.length < 7) continue;
    const [sha, an, ae, cn, ce, body, ...rest] = parts;
    const short = sha.slice(0, 10);
    commits++;
    findings.push(...scanner.identity(an, ae, `commit ${short} author`));
    findings.push(...scanner.identity(cn, ce, `commit ${short} committer`));
    findings.push(...scanner.message(body, `commit ${short} message`));
    if (withPatch) findings.push(...scanDiffFiles(scanner, parseDiff(rest.join(US)), `commit ${short} `));
  }
  return { findings, commits };
}

export function resolveObject(dir, rev, env) {
  const out = git(['rev-parse', '--verify', '--quiet', `${rev}`], { cwd: dir, env, allowFail: true });
  return out ? out.trim() : null;
}

export function objectType(dir, sha, env) {
  const out = git(['cat-file', '-t', sha], { cwd: dir, env, allowFail: true });
  return out ? out.trim() : null;
}

// Annotated tag messages and taggers are published with the tag.
export function scanTagObject(scanner, dir, sha, label, env) {
  const raw = git(['cat-file', 'tag', sha], { cwd: dir, env });
  const blank = raw.indexOf('\n\n');
  const header = blank === -1 ? raw : raw.slice(0, blank);
  let message = blank === -1 ? '' : raw.slice(blank + 2);
  const sig = message.indexOf('-----BEGIN ');
  if (sig !== -1) message = message.slice(0, sig);
  const tagger = /^tagger (.*) \d+ [+-]\d{4}$/m.exec(header);
  const findings = [];
  if (tagger) {
    const id = parseIdent(tagger[1]);
    findings.push(...scanner.identity(id.name, id.email, `tag ${label} tagger`));
  }
  findings.push(...scanner.message(message, `tag ${label} message`));
  return findings;
}

// Refs in `prefix` (e.g. refs/heads/) as [{ name, sha, type }].
export function listRefs(dir, patterns, env) {
  const out = git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', ...patterns], { cwd: dir, env });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, sha, type] = l.split('\0');
      return { name, sha, type };
    });
}

export function hooksDir(dir, env) {
  const out = git(['rev-parse', '--git-path', 'hooks'], { cwd: dir, env });
  return resolve(dir, out.trim());
}

