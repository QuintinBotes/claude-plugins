// Claude Code PreToolUse hook. Finds the publishing commands in a Bash call
// (git commit, git push, gh pr/issue/release/gist/api/repo/label writes) or a
// GitHub MCP write, decides whether they target a protected owner, and scans
// what they would publish. Everything else passes untouched: the hook prints
// nothing, so Claude Code's normal permission flow decides. It never prints
// "allow", which would auto-approve the call.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isProtectedOwner, loadConfig, scannerFor } from './config.mjs';
import * as G from './git.mjs';
import { parseGhRepoArg, parseGitHubUrl } from './github.mjs';
import { dedupe, formatReport } from './scan.mjs';
import { commandName, parseShell } from './shell.mjs';
import { GuardError, isBinary, readTextFile, resolveFrom } from './util.mjs';

// Cheap pre-filter run before anything is loaded: a Bash call that never
// mentions git or gh cannot publish through them.
export const MAYBE_PUBLISHING = /\b(git|gh)\b/;

// Text the parser could not attribute to a command (inside quotes passed to
// an unknown wrapper, for example) but that still reads like publishing.
const FALLBACK = /\bgit\b[^\n;&|]*\b(commit|push)\b|\bgh\b[^\n;&|]*\b(pr|issue|release|gist|api|repo|label)\b/;

const GIT_BUILTINS = new Set(
  ('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap checkout ' +
    'checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects ' +
    'credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch filter-branch ' +
    'for-each-ref format-patch fsck gc grep gui hash-object help index-pack init instaweb interpret-trailers log ' +
    'ls-files ls-remote ls-tree maintenance merge merge-base merge-file merge-tree mergetool mktag mktree mv name-rev ' +
    'notes pack-objects pack-refs prune pull push range-diff read-tree rebase reflog remote repack replace ' +
    'request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show show-branch show-ref ' +
    'sparse-checkout stage stash status submodule switch symbolic-ref tag unpack-objects update-index update-ref ' +
    'var verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs').split(' '),
);

// gh subcommands that write text somewhere public.
const GH_WRITES = {
  pr: new Set(['create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen']),
  issue: new Set(['create', 'edit', 'comment', 'close', 'reopen', 'develop']),
  release: new Set(['create', 'edit', 'upload']),
  gist: new Set(['create', 'edit']),
  repo: new Set(['create', 'edit', 'rename']),
  label: new Set(['create', 'edit']),
  project: new Set(['create', 'edit', 'copy', 'item-create', 'item-edit', 'item-add', 'field-create', 'mark-template', 'link']),
};

// Flags that take a value, per gh group, so positionals (gist files, release
// assets, the api endpoint) are found correctly.
const GH_VALUE_FLAGS = {
  common: ['-R', '--repo'],
  pr: ['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template', '-A', '--author-email', '--subject', '--match-head-commit', '-c', '--comment', '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer', '--recover'],
  issue: ['-t', '--title', '-b', '--body', '-F', '--body-file', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-T', '--template', '-c', '--comment', '-r', '--reason', '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project', '--remove-project', '--recover', '--duplicate-of'],
  release: ['-t', '--title', '-n', '--notes', '-F', '--notes-file', '--target', '--discussion-category', '--notes-start-tag', '--tag', '--latest'],
  gist: ['-d', '--desc', '-f', '--filename', '-a', '--add', '-r', '--remove'],
  repo: ['-d', '--description', '-h', '--homepage', '--template', '-g', '--gitignore', '-l', '--license', '-t', '--team', '-s', '--source', '-r', '--remote', '--add-topic', '--remove-topic', '--default-branch', '--visibility'],
  label: ['-d', '--description', '-c', '--color', '-n', '--name'],
  project: ['--owner', '--source-owner', '--target-owner', '--title', '--body', '--format', '-q', '--jq', '-t', '--template', '--id', '--field-id', '--project-id', '--text', '--number', '--date', '--single-select-option-id', '--iteration-id', '--name', '--data-type', '--single-select-options', '--url', '--visibility', '--readme', '--description', '-L', '--limit'],
  api: ['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'],
};

// Flags whose value is a file whose content gets published.
const GH_FILE_FLAGS = {
  pr: ['-F', '--body-file', '-T', '--template'],
  issue: ['-F', '--body-file'],
  release: ['-F', '--notes-file'],
  gist: ['-a', '--add'],
  api: ['--input'],
};

// `gh pr create --template` takes a template file or the name of one of the
// repository's templates, so a value that is not a file is not an error.
const GH_OPTIONAL_FILE_FLAGS = new Set(['-T', '--template']);

// Paths that are standard input under another name.
const STDIN_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

// --- Phase 1: walk the command and record publishing operations ---------------

// $NAME and ${NAME} from the command's own assignments and the hook's
// environment. Unknown names are left as written.
function expandVars(word, vars) {
  return word.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => vars[a ?? b] ?? m);
}

const TOPLEVEL = /^(\$\(|`)\s*git\s+rev-parse\s+--show-toplevel\s*(\)|`)$/;

function resolveDir(cwd, path, env, vars = {}) {
  if (path === undefined || path === '' || path === '~') return env.HOME ?? cwd;
  // `cd "$(git rev-parse --show-toplevel)"` is common in agent commands.
  if (TOPLEVEL.test(path)) {
    const base = { ...env };
    delete base.GIT_DIR;
    delete base.GIT_WORK_TREE;
    return G.topLevel(cwd, G.gitEnv(base)) ?? cwd;
  }
  const expanded = expandVars(path, { ...env, PWD: cwd, ...vars });
  // A directory only known when the command runs: stay in the current one,
  // which is right for the common cases and keeps the check on.
  if (/[$`]/.test(expanded)) return cwd;
  return resolveFrom(cwd, expanded, env);
}

// Files whose whole content a command's words take in through `$(cat FILE)`,
// `$(< FILE)` or the backtick forms: that content is part of what the command
// publishes. Output that another program transforms is not followed.
function substitutionReads(cmd, dir, vars) {
  const out = [];
  const visit = (sub) => {
    if (sub.commands.length === 1) {
      const [c] = sub.commands;
      const words = c.words.map((w) => w.value);
      if (commandName(words[0]) === 'cat' && c.stdin === null) {
        for (const w of words.slice(1)) if (!w.startsWith('-')) out.push(resolveFrom(dir, expandVars(w, vars)));
      }
      if (!words.length) for (const r of c.redirs) if (r.op === '<') out.push(resolveFrom(dir, expandVars(r.target, vars)));
    }
    for (const c of sub.commands) for (const s of c.substs) visit(s);
  };
  for (const sub of cmd.substs) visit(sub);
  return out;
}

function skipOptions(words, start, withValue = []) {
  let k = start;
  while (k < words.length && words[k].startsWith('-') && words[k] !== '-') {
    if (words[k] === '--') return k + 1;
    if (withValue.includes(words[k])) k++;
    k++;
  }
  return k;
}

class Walker {
  constructor(cwd, env) {
    this.ops = [];
    this.sawTool = false;
    // Files read into variables (`BODY=$(cat body.md)`) by earlier commands
    // of the same call, which a later git or gh command may publish.
    this.assignedReads = [];
    this.env = env;
    this.state = { cwd, vars: {} };
  }

  walk(script, depth = 0) {
    if (depth > 6) {
      this.ops.push({ type: 'opaque', dir: this.state.cwd });
      return;
    }
    let parsed;
    try {
      parsed = parseShell(script);
    } catch {
      this.ops.push({ type: 'opaque', dir: this.state.cwd });
      return;
    }
    for (const cmd of parsed.commands) this.handle(cmd, depth);
  }

  handle(cmd, depth) {
    for (const sub of cmd.substs) {
      const saved = { ...this.state, vars: { ...this.state.vars } };
      for (const c of sub.commands) this.handle(c, depth + 1);
      this.state = saved;
    }
    let words = cmd.words.map((w) => w.value);
    const vars = { ...this.state.vars };
    for (const a of cmd.assigns) vars[a.name] = a.value;
    if (!words.length) {
      Object.assign(this.state.vars, vars);
      this.assignedReads.push(...substitutionReads(cmd, this.state.cwd, { ...this.env, ...vars }));
      return;
    }
    for (let guard = 0; guard < 10 && words.length; guard++) {
      const name = commandName(words[0]);
      if (name === 'env') {
        let k = 1;
        while (k < words.length) {
          const w = words[k];
          if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(w)) k += 2;
          else if (w.startsWith('-')) k++;
          else if (ASSIGN.test(w)) {
            const m = ASSIGN.exec(w);
            vars[m[1]] = m[2];
            k++;
          } else break;
        }
        words = words.slice(k);
      } else if (['command', 'builtin', 'exec', 'nohup', 'time', 'caffeinate', 'stdbuf', 'unbuffer', 'chronic', 'noglob'].includes(name)) {
        words = words.slice(skipOptions(words, 1));
      } else if (name === 'sudo' || name === 'doas') {
        words = words.slice(skipOptions(words, 1, ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t', '-T']));
      } else if (name === 'nice') {
        words = words.slice(skipOptions(words, 1, ['-n']));
      } else if (name === 'timeout' || name === 'gtimeout') {
        words = words.slice(skipOptions(words, 1, ['-s', '--signal', '-k', '--kill-after']) + 1);
      } else if (name === 'xargs') {
        words = words.slice(skipOptions(words, 1, ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a']));
      } else if (name === 'watch') {
        this.walk(words.slice(skipOptions(words, 1, ['-n', '--interval', '-d'])).join(' '), depth + 1);
        return;
      } else break;
    }
    if (!words.length) return;
    const name = commandName(words[0]);
    const args = words.slice(1);
    switch (name) {
      case 'cd':
      case 'pushd':
        this.state.cwd = resolveDir(this.state.cwd, args.find((a) => !a.startsWith('-')), this.env, vars);
        return;
      case 'export':
      case 'declare':
      case 'typeset':
      case 'local':
      case 'readonly':
        this.assignedReads.push(...substitutionReads(cmd, this.state.cwd, { ...this.env, ...vars }));
        for (const a of args) {
          const m = ASSIGN.exec(a);
          if (m) this.state.vars[m[1]] = m[2];
        }
        return;
      case 'bash':
      case 'sh':
      case 'zsh':
      case 'dash':
      case 'ksh': {
        const i = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        if (i >= 0 && args[i + 1] !== undefined) this.walk(args[i + 1], depth + 1);
        else if (cmd.stdin) this.walk(cmd.stdin, depth + 1);
        return;
      }
      case 'eval':
        this.walk(args.join(' '), depth + 1);
        return;
      case 'git':
        this.sawTool = true;
        this.git(args, cmd, vars, depth);
        return;
      case 'gh':
        this.sawTool = true;
        this.gh(args, cmd, vars);
        return;
      default:
    }
  }

  git(args, cmd, vars, depth) {
    let dir = this.state.cwd;
    const configArgs = [];
    const gitVars = { ...vars };
    let k = 0;
    while (k < args.length) {
      const a = args[k];
      if (a === '-C') {
        dir = resolveDir(dir, args[k + 1] ?? '.', this.env, vars);
        k += 2;
      } else if (a === '-c') {
        configArgs.push('-c', args[k + 1] ?? '');
        k += 2;
      } else if (a.startsWith('--config-env=')) {
        configArgs.push(a);
        k++;
      } else if (a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--config-env') {
        if (a === '--git-dir') gitVars.GIT_DIR = resolveDir(dir, args[k + 1], this.env, vars);
        if (a === '--work-tree') gitVars.GIT_WORK_TREE = resolveDir(dir, args[k + 1], this.env, vars);
        if (a === '--config-env') configArgs.push(`--config-env=${args[k + 1] ?? ''}`);
        k += 2;
      } else if (a.startsWith('--git-dir=')) {
        gitVars.GIT_DIR = resolveDir(dir, a.slice(10), this.env, vars);
        k++;
      } else if (a.startsWith('--work-tree=')) {
        gitVars.GIT_WORK_TREE = resolveDir(dir, a.slice(12), this.env, vars);
        k++;
      } else if (a.startsWith('-')) {
        k++;
      } else break;
    }
    const sub = args[k];
    const rest = args.slice(k + 1);
    if (!sub) return;
    const base = { dir, configArgs, vars: gitVars, cmd, substFiles: [...this.assignedReads, ...substitutionReads(cmd, this.state.cwd, { ...this.env, ...vars })] };
    if (sub === 'add' || sub === 'stage') {
      const paths = rest.filter((a) => !a.startsWith('-'));
      const all = rest.some((a) => /^(-A|--all|-u|--update|--no-ignore-removal)$/.test(a)) || /^-[a-zA-Z]*[Au]/.test(rest.find((a) => /^-[a-zA-Z]+$/.test(a)) ?? '');
      this.ops.push({ type: 'git-add', ...base, all: all || paths.length === 0, paths });
      return;
    }
    if (sub === 'commit') {
      this.ops.push(parseCommit(rest, base));
      return;
    }
    if (sub === 'push') {
      this.ops.push(parsePush(rest, base));
      return;
    }
    if (GIT_BUILTINS.has(sub) || depth > 3) return;
    const alias = G.git([...configArgs, 'config', '--get', `alias.${sub}`], { cwd: dir, env: G.gitEnv(this.env), allowFail: true });
    if (!alias) return;
    const value = alias.trim();
    if (value.startsWith('!')) {
      const saved = this.state.cwd;
      this.state.cwd = dir;
      this.walk(`${value.slice(1)} ${rest.map(shellQuote).join(' ')}`, depth + 1);
      this.state.cwd = saved;
      return;
    }
    const aliasWords = parseShell(value).commands[0]?.words.map((w) => w.value) ?? [];
    this.git(['-C', dir, ...configArgs, ...aliasWords, ...rest], cmd, vars, depth + 1);
  }

  gh(args, cmd, vars) {
    const group = args[0];
    const isApi = group === 'api';
    if (!isApi && !GH_WRITES[group]) return;
    const valueFlags = new Set([...GH_VALUE_FLAGS.common, ...(GH_VALUE_FLAGS[group] ?? [])]);
    const fileFlags = new Set(GH_FILE_FLAGS[group] ?? []);
    // `-R/--repo` is a flag of the command group, so gh also accepts it
    // before the subcommand: `gh pr --repo owner/repo create`.
    let subAt = 1;
    const lead = [];
    while (!isApi && subAt < args.length && args[subAt].startsWith('-')) {
      const a = args[subAt++];
      lead.push(a);
      if ((a === '-R' || a === '--repo') && subAt < args.length) lead.push(args[subAt++]);
    }
    const op = {
      type: 'gh',
      group,
      sub: isApi ? 'api' : args[subAt],
      dir: this.state.cwd,
      vars,
      cmd,
      repoArg: null,
      files: [],
      positional: [],
      flags: new Map(),
      fields: [],
      substFiles: [...this.assignedReads, ...substitutionReads(cmd, this.state.cwd, { ...this.env, ...vars })],
    };
    if (!isApi && !GH_WRITES[group].has(op.sub)) return;
    const rest = isApi ? args.slice(1) : [...lead, ...args.slice(subAt + 1)];
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === '--') {
        op.positional.push(...rest.slice(k + 1));
        break;
      }
      let flag = a;
      let value;
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) {
        flag = a.slice(0, eq);
        value = a.slice(eq + 1);
      } else if (/^-[A-Za-z]./.test(a) && valueFlags.has(a.slice(0, 2))) {
        flag = a.slice(0, 2);
        value = a.slice(2);
      } else if (a.startsWith('-') && a !== '-') {
        if (valueFlags.has(a)) value = rest[++k];
        else value = true;
      } else {
        op.positional.push(a);
        continue;
      }
      if (!op.flags.has(flag)) op.flags.set(flag, []);
      op.flags.get(flag).push(value);
      if (flag === '-R' || flag === '--repo') op.repoArg = value;
      if (fileFlags.has(flag) && typeof value === 'string') op.files.push({ path: value, flag, optional: GH_OPTIONAL_FILE_FLAGS.has(flag) });
      if (isApi && ['-f', '--raw-field', '-F', '--field'].includes(flag) && typeof value === 'string') {
        op.fields.push({ flag, value });
      }
    }
    if (isApi) {
      op.endpoint = op.positional[0] ?? '';
      const method = (op.flags.get('-X') ?? op.flags.get('--method') ?? []).at(-1);
      const hasBody = op.fields.length > 0 || op.flags.has('--input');
      op.method = typeof method === 'string' ? method.toUpperCase() : hasBody ? 'POST' : 'GET';
      if (op.method === 'GET' || op.method === 'HEAD') return;
      for (const f of op.fields) {
        const at = f.value.indexOf('=@');
        if ((f.flag === '-F' || f.flag === '--field') && at > 0) op.files.push({ path: f.value.slice(at + 2), flag: f.flag });
      }
      // GraphQL goes out as a POST either way; only a mutation writes. A
      // query read from a file is kept, since its text is not visible here.
      if (/^\/?graphql$/.test(op.endpoint) && !op.files.length && !op.fields.some((f) => /\bmutation\b/.test(f.value))) return;
    }
    if (op.flags.has('--dry-run')) return;
    if (group === 'gist' && op.sub === 'create') {
      for (const p of op.positional) op.files.push({ path: p, flag: 'file', optional: true });
      // With no file arguments gist create reads standard input.
      const piped = cmd.stdin !== null || cmd.pipeFrom || cmd.redirs.some((r) => r.op === '<');
      if (!op.positional.length && piped) op.files.push({ path: '-', flag: 'stdin' });
    }
    if (group === 'release' && (op.sub === 'create' || op.sub === 'upload')) {
      for (const p of op.positional.slice(1)) op.files.push({ path: p.replace(/#.*$/, ''), flag: 'asset', optional: true });
    }
    this.ops.push(op);
  }
}

function shellQuote(s) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseCommit(args, base) {
  const op = { type: 'git-commit', ...base, messages: [], files: [], reuse: [], trailers: [], author: null, all: false, paths: [] };
  const valued = new Set(['message', 'file', 'reuse-message', 'reedit-message', 'author', 'trailer', 'template', 'fixup', 'squash', 'cleanup', 'date', 'pathspec-from-file']);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      op.paths.push(...args.slice(k + 1));
      break;
    }
    const long = /^--([^=]+)(?:=(.*))?$/s.exec(a);
    if (long) {
      const name = long[1];
      const value = valued.has(name) ? (long[2] ?? args[++k]) : long[2];
      if (name === 'message') op.messages.push(value);
      else if (name === 'file' || name === 'template') op.files.push(value);
      else if (name === 'reuse-message' || name === 'reedit-message') op.reuse.push(value);
      else if (name === 'author') op.author = value;
      else if (name === 'trailer') op.trailers.push(value);
      else if (name === 'all') op.all = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ('mFCct'.includes(ch)) {
          const value = a.slice(j + 1) || args[++k];
          if (ch === 'm') op.messages.push(value);
          else if (ch === 'F' || ch === 't') op.files.push(value);
          else op.reuse.push(value);
          break;
        }
        if (ch === 'a') op.all = true;
        if (ch === 'S' || ch === 'u') break;
      }
      continue;
    }
    op.paths.push(a);
  }
  return op;
}

function parsePush(args, base) {
  const op = { type: 'git-push', ...base, positional: [], all: false, mirror: false, tags: false, followTags: null, del: false, dryRun: false, repo: null };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      op.positional.push(...args.slice(k + 1));
      break;
    }
    if (a === '--all' || a === '--branches') op.all = true;
    else if (a === '--mirror') op.mirror = true;
    else if (a === '--tags') op.tags = true;
    else if (a === '--follow-tags') op.followTags = true;
    else if (a === '--no-follow-tags') op.followTags = false;
    else if (a === '--delete') op.del = true;
    else if (a === '--dry-run') op.dryRun = true;
    else if (a === '--repo') op.repo = args[++k];
    else if (a.startsWith('--repo=')) op.repo = a.slice(7);
    else if (a === '--push-option' || a === '--receive-pack' || a === '--exec') k++;
    else if (a.startsWith('--')) continue;
    else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'd') op.del = true;
        if (ch === 'n') op.dryRun = true;
        if (ch === 'o') {
          if (!a.slice(j + 1)) k++;
          break;
        }
      }
    } else op.positional.push(a);
  }
  return op;
}

// --- Phase 2: evaluate the operations against the config ----------------------

class Evaluation {
  constructor({ config, env, command, scanner }) {
    this.config = config;
    this.env = env;
    this.command = command;
    this.findings = [];
    this.targets = new Set();
    this._scanner = scanner ?? null;
    this.added = new Map();
  }

  scanner() {
    if (!this._scanner) this._scanner = scannerFor(this.config);
    return this._scanner;
  }

  gitEnv(vars = {}) {
    // Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE would point every
    // git call at the session's repository instead of the one the command
    // targets; the command's own assignments are applied on top.
    const base = { ...this.env };
    delete base.GIT_DIR;
    delete base.GIT_WORK_TREE;
    delete base.GIT_INDEX_FILE;
    return G.gitEnv(base, vars);
  }

  add(findings) {
    this.findings.push(...findings);
  }

  protect(label) {
    this.targets.add(label);
  }

  isProtected(owner) {
    return isProtectedOwner(this.config, owner);
  }
}

function describeRepo(info, env) {
  const t = G.repoTargets(info, env)[0];
  return t ? `${t.owner}/${t.repo}` : info.dir;
}

// stdin of a command: heredoc or here-string, `< file`, or `cat file |`.
function stdinOf(cmd, dir, vars) {
  if (cmd.stdin !== null) return { text: cmd.stdin };
  const redir = cmd.redirs.find((r) => r.op === '<' && (r.fd === null || r.fd === 0));
  if (redir) return { files: [resolveFrom(dir, expandVars(redir.target, vars))] };
  const prev = cmd.pipeFrom;
  if (prev) {
    const words = prev.words.map((w) => w.value);
    const name = commandName(words[0]);
    if (name === 'cat' && prev.stdin === null) return { files: words.slice(1).filter((w) => !w.startsWith('-')).map((w) => resolveFrom(dir, expandVars(w, vars))) };
    if (name === 'cat' && prev.stdin !== null) return { text: prev.stdin };
    if (name === 'echo' || name === 'printf') return { text: words.slice(1).join(' ') };
    return { unknown: true };
  }
  return { unknown: true };
}

// How the same Bash call writes `path`, so a file that does not exist yet,
// or is about to be replaced, is judged by what will be in it:
// { inline } for text visible in the command (`cat > body.md <<'EOF'`,
// `echo ... > body.md`), { files } for copies of other files (`cat a.md >
// body.md`, `cp a.md body.md`), { unknown } for output of any other program.
function writersOf(command, path, dir, vars) {
  let parsed;
  try {
    parsed = parseShell(command);
  } catch {
    return [{ unknown: true }];
  }
  const all = [];
  const collect = (cmds) => {
    for (const c of cmds) {
      all.push(c);
      for (const s of c.substs) collect(s.commands);
    }
  };
  collect(parsed.commands);
  const at = (w) => resolveFrom(dir, expandVars(w, vars));
  const sources = (words) => words.filter((w) => !w.startsWith('-')).map(at);
  const out = [];
  for (const c of all) {
    const words = c.words.map((w) => w.value);
    const name = commandName(words[0]);
    if (['cp', 'mv', 'install', 'ln'].includes(name) && words.length >= 3 && at(words.at(-1)) === path) {
      out.push({ files: sources(words.slice(1, -1)) });
      continue;
    }
    const redirect = c.redirs.find((r) => ['>', '>>', '>|', '&>', '&>>'].includes(r.op) && at(r.target) === path);
    const teed = name === 'tee' && words.slice(1).some((w) => !w.startsWith('-') && at(w) === path);
    if (!redirect && !teed) continue;
    if (redirect && redirect.fd !== null && redirect.fd !== 1) out.push({ unknown: true });
    else if (teed) {
      const input = stdinOf(c, dir, vars);
      out.push(input.text !== undefined ? { inline: true } : input.files ? { files: input.files } : { unknown: true });
    } else if (c.stdin !== null && (!words.length || (name === 'cat' && words.length === 1))) out.push({ inline: true });
    else if (name === 'cat' && words.length > 1) out.push({ files: sources(words.slice(1)) });
    else if (name === 'echo' || name === 'printf') out.push({ inline: true });
    else out.push({ unknown: true });
  }
  return out;
}

function scanFileArg(ev, s, file, dir, cmd, label, vars = {}) {
  if (STDIN_PATHS.has(file.path)) {
    const input = stdinOf(cmd, dir, vars);
    if (input.text !== undefined) ev.add(s.message(input.text, `${label} (stdin)`));
    else if (input.files) for (const f of input.files) scanPath(ev, s, f, label, false, dir, vars);
    else ev.add([{ kind: 'error', where: label, message: 'text arrives on stdin from a program publish-guard cannot read; write it to a file first and pass the file' }]);
    return;
  }
  const path = resolveFrom(dir, expandVars(file.path, vars));
  if (file.optional && /[*?[]/.test(path.slice(path.lastIndexOf('/') + 1))) {
    for (const p of expandGlob(path)) scanPath(ev, s, p, label, true, dir, vars);
    return;
  }
  scanPath(ev, s, path, label, file.optional, dir, vars);
}

// The shell expands `gh release create v1 dist/*.md` before gh runs; only
// the last path segment is expanded here, which covers the usual forms.
function expandGlob(path) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash) || '/';
  try {
    const re = new RegExp(
      `^${path
        .slice(slash + 1)
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    );
    return readdirSync(dir)
      .filter((n) => re.test(n) && !n.startsWith('.'))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function scanPath(ev, s, path, label, optional, dir, vars = {}, depth = 0) {
  const writers = depth < 4 ? writersOf(ev.command, path, dir, vars) : [];
  for (const w of writers) {
    if (w.files) for (const f of w.files) scanPath(ev, s, f, `${label} (copied from)`, false, dir, vars, depth + 1);
    else if (w.unknown) ev.add([{ kind: 'error', where: `${label} ${path}`, message: 'this command fills the file from a program publish-guard cannot read; write it in an earlier step, then pass it' }]);
  }
  const res = readTextFile(path);
  if (res.text !== undefined) {
    ev.add(s.message(res.text, `${label} ${path}`));
  } else if (res.missing && !optional && !writers.length) {
    ev.add([{ kind: 'error', where: `${label} ${path}`, message: 'file does not exist yet, so it cannot be checked; create it in an earlier step' }]);
  } else if (res.skipped && !optional) {
    ev.add([{ kind: 'error', where: `${label} ${path}`, message: `cannot be checked (${res.skipped}); pass the text in a regular text file` }]);
  }
}

// Base64 hides text from a plain scan, and the contents API takes file
// content that way. Runs that decode to readable text are scanned as well.
function decodedBase64(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z0-9+/]{24,}(?:[\r\n]+[A-Za-z0-9+/]{4,})*={0,2}/g)) {
    const buf = Buffer.from(m[0].replace(/\s+/g, ''), 'base64');
    if (buf.length < 8 || isBinary(buf)) continue;
    const decoded = buf.toString('utf8');
    if (/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(decoded)) continue;
    out.push(decoded);
  }
  return out;
}

function evalCommit(op, ev) {
  const env = ev.gitEnv(op.vars);
  const info = G.repoInfo(op.dir, { env });
  if (!info || !G.repoIsProtected(info, ev.config, env)) return;
  ev.protect(describeRepo(info, env));
  const s = ev.scanner();
  const vars = { ...ev.env, ...op.vars };
  for (const m of op.messages) ev.add(s.message(m, 'commit message'));
  for (const f of op.files) scanFileArg(ev, s, { path: f }, op.dir, op.cmd, 'commit message file', vars);
  for (const f of op.substFiles) scanPath(ev, s, f, 'command substitution', false, op.dir, vars);
  for (const r of op.reuse) {
    const body = G.git(['log', '-1', '--format=%B', r, '--'], { cwd: op.dir, env, allowFail: true });
    if (body !== null) ev.add(s.message(body, `commit message reused from ${r}`));
  }
  for (const t of op.trailers) ev.add(s.message(t.replace(/^([^:=]+)[=:]\s*/, '$1: '), 'commit trailer'));

  const ids = G.effectiveIdentities(op.dir, { env, configArgs: op.configArgs });
  if (op.author && /<[^>]*>/.test(op.author)) ids.author = G.parseIdent(op.author);
  ev.add(G.scanIdentities(s, ids, 'new commit '));

  const added = ev.added.get(info.gitDir);
  let files;
  if (added) {
    const paths = added.all ? null : [...added.paths];
    files = G.stagedDiff(op.dir, { env, all: true, paths });
    files.push(...G.untrackedFiles(op.dir, { env, paths }));
    if (paths) files.push(...G.stagedDiff(op.dir, { env }));
  } else {
    files = G.stagedDiff(op.dir, { env, all: op.all, paths: op.paths.length ? op.paths : null });
  }
  ev.add(G.scanDiffFiles(s, files, 'staged '));
}

function evalAdd(op, ev) {
  const env = ev.gitEnv(op.vars);
  const info = G.repoInfo(op.dir, { env });
  if (!info) return;
  const cur = ev.added.get(info.gitDir) ?? { all: false, paths: new Set() };
  if (op.all) cur.all = true;
  for (const p of op.paths) cur.paths.add(resolveFrom(op.dir, p));
  ev.added.set(info.gitDir, cur);
}

function sameRepo(a, b) {
  return a && b && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

function evalPush(op, ev) {
  if (op.dryRun) return;
  const env = ev.gitEnv(op.vars);
  const info = G.repoInfo(op.dir, { env });
  if (!info) return;
  const branch = G.currentBranch(op.dir, env);
  const repoArg = op.repo ?? op.positional[0];
  const refspecs = op.repo ? op.positional : op.positional.slice(1);
  let remoteName = null;
  let urls;
  if (repoArg && info.remotes.has(repoArg)) {
    remoteName = repoArg;
    urls = info.remotes.get(repoArg).resolvedPushUrls;
  } else if (repoArg) {
    urls = [info.rewritePush(repoArg)];
  } else {
    remoteName = G.defaultPushRemote(info, branch);
    urls = info.remotes.get(remoteName)?.resolvedPushUrls ?? [];
  }
  const targets = G.ownersOf(urls, env);
  if (!info.forceProtect && !targets.some((t) => ev.isProtected(t.owner))) return;
  ev.protect(targets[0] ? `${targets[0].owner}/${targets[0].repo}` : describeRepo(info, env));
  const s = ev.scanner();
  if (op.del) return;

  const srcs = [];
  const addSpec = (spec) => {
    const s2 = spec.replace(/^\+/, '');
    if (s2.startsWith(':')) return;
    const src = s2.includes(':') ? s2.slice(0, s2.indexOf(':')) : s2;
    if (!src) return;
    if (src.includes('*')) {
      const prefix = src.slice(0, src.indexOf('*'));
      srcs.push(...G.listRefs(op.dir, [prefix.endsWith('/') ? prefix : prefix.replace(/[^/]*$/, '')], env).filter((r) => r.name.startsWith(prefix)));
      return;
    }
    const sha = G.resolveObject(op.dir, src, env);
    if (sha) srcs.push({ name: src, sha, type: G.objectType(op.dir, sha, env) });
  };
  // push.followTags and remote.<name>.mirror change what a plain push sends.
  const followTags = op.followTags ?? /^(true|yes|on|1)$/i.test(info.get('push.followtags') ?? '');
  if (op.mirror || (remoteName && /^(true|yes|on|1)$/i.test(info.get(`remote.${remoteName}.mirror`) ?? ''))) {
    srcs.push(...G.listRefs(op.dir, ['refs/heads/', 'refs/tags/'], env));
  } else {
    if (op.all) srcs.push(...G.listRefs(op.dir, ['refs/heads/'], env));
    if (op.tags) srcs.push(...G.listRefs(op.dir, ['refs/tags/'], env));
    for (const spec of refspecs) addSpec(spec);
    if (!refspecs.length && !op.all && !op.tags) {
      const configured = remoteName ? (info.getAll?.(`remote.${remoteName}.push`) ?? []) : [];
      if (configured.length) configured.forEach(addSpec);
      else if (info.get('push.default') === 'matching') srcs.push(...G.listRefs(op.dir, ['refs/heads/'], env));
      else if (branch) addSpec('HEAD');
    }
    if (followTags) srcs.push(...G.listRefs(op.dir, ['refs/tags/'], env).filter((r) => r.type === 'tag'));
  }
  if (!srcs.length) return;

  for (const r of srcs) if (r.type === 'tag') ev.add(G.scanTagObject(s, op.dir, r.sha, r.name.replace(/^refs\/tags\//, ''), env));

  // Commits already on the target remote (per its remote-tracking refs) are
  // excluded; everything else reachable from what is pushed is outgoing. For
  // a remote with no tracking refs that means its whole history, which is
  // right: a first push publishes all of it.
  const names = remoteName
    ? [remoteName]
    : [...info.remotes.values()].filter((r) => [...r.fetchUrls, ...r.resolvedPushUrls].some((u) => u === urls[0] || sameRepo(parseGitHubUrl(u, env), targets[0]))).map((r) => r.name);
  const revs = [...new Set(srcs.map((r) => r.sha))];
  if (names.length) revs.push('--not', ...names.map((n) => `--remotes=${n}`));
  ev.add(G.scanCommits(s, op.dir, revs, { env }).findings);
}

const USER = Symbol('authenticated user');

function ghOwners(op, ev, env) {
  if (op.repoArg) {
    const r = parseGhRepoArg(op.repoArg, env);
    return r ? [r.owner] : [];
  }
  if (op.group === 'gist') return [USER];
  if (op.group === 'repo' && op.sub === 'create') {
    const name = op.positional[0] ?? '';
    return name.includes('/') ? [name.split('/')[0]] : [USER];
  }
  if (op.group === 'repo' && op.sub === 'edit' && op.positional[0]) {
    const r = parseGhRepoArg(op.positional[0], env);
    return [r ? r.owner : USER];
  }
  if (op.group === 'project') {
    const owner = (op.flags.get(op.sub === 'copy' ? '--target-owner' : '--owner') ?? op.flags.get('--owner') ?? []).at(-1);
    return [typeof owner === 'string' && owner !== '@me' ? owner : USER];
  }
  if (op.group === 'api') {
    const ep = op.endpoint.replace(/^https:\/\/api\.github\.com\//, '').replace(/^\/+/, '');
    const host = (op.flags.get('--hostname') ?? []).at(-1);
    if (typeof host === 'string' && !/github\.com$/i.test(host)) return [];
    let m = /^(?:repos|orgs|users)\/([^/{}]+)/.exec(ep);
    if (m) return [m[1]];
    if (/^(gists|user)(\/|$)/.test(ep)) return [USER];
    if (!/^repos\/\{owner\}/.test(ep) && !ep.startsWith('graphql')) return [USER];
    // {owner} placeholders and graphql resolve against the current repository.
  }
  // GH_REPO replaces the current directory's repository for gh.
  if (env.GH_REPO) {
    const r = parseGhRepoArg(env.GH_REPO, env);
    return [r ? r.owner : USER];
  }
  const info = G.repoInfo(op.dir, { env });
  if (!info) return op.group === 'api' ? [USER] : [];
  if (info.forceProtect) return [USER];
  const resolved = [...info.remotes.values()].find((r) => r.ghResolved === 'base');
  const urls = resolved ? resolved.fetchUrls : [...info.remotes.values()].flatMap((r) => [...r.fetchUrls, ...r.resolvedPushUrls]);
  return G.ownersOf(urls, env).map((t) => t.owner);
}

function evalGh(op, ev) {
  const env = ev.gitEnv(op.vars);
  const owners = ghOwners(op, ev, env);
  const hit = owners.find((o) => o === USER || ev.isProtected(o));
  if (hit === undefined) return;
  ev.protect(hit === USER ? 'your GitHub account' : hit);
  const s = ev.scanner();
  const label = `gh ${op.group}${op.group === 'api' ? '' : ` ${op.sub}`}`;
  const vars = { ...ev.env, ...op.vars };
  for (const f of op.files) scanFileArg(ev, s, f, op.dir, op.cmd, `${label} ${f.flag}`, vars);
  for (const f of op.substFiles) scanPath(ev, s, f, 'command substitution', false, op.dir, vars);
  if (op.group === 'api') {
    const payload = [ev.command];
    for (const f of op.files) {
      if (STDIN_PATHS.has(f.path)) continue;
      const res = readTextFile(resolveFrom(op.dir, expandVars(f.path, vars)));
      if (res.text !== undefined) payload.push(res.text);
    }
    for (const text of payload) for (const d of decodedBase64(text)) ev.add(s.message(d, `${label} payload (base64-decoded)`));
  }

  if (op.group === 'pr' && op.sub === 'merge' && ev.config.requireMergeAuthorEmail) {
    const squashOrMerge = ['-s', '--squash', '-m', '--merge'].some((f) => op.flags.has(f));
    const email = (op.flags.get('-A') ?? op.flags.get('--author-email') ?? []).at(-1);
    if (typeof email === 'string') {
      if (!s.emails.isAllowed(email)) ev.add([s.emailFinding(email, `${label} --author-email`, undefined, 'identity')]);
    } else if (squashOrMerge || op.flags.has('--auto')) {
      ev.add([{ kind: 'error', where: label, message: 'pass --author-email <an allowed address>; without it GitHub authors the merge commit with the account default email' }]);
    }
  }
  if (op.group === 'repo' && op.sub === 'create' && op.flags.has('--push')) {
    // `gh repo create --source DIR --push` publishes that history in full.
    const source = (op.flags.get('-s') ?? op.flags.get('--source') ?? []).at(-1);
    const dir = typeof source === 'string' ? resolveFrom(op.dir, source) : op.dir;
    if (G.repoInfo(dir, { env }) && G.hasHead(dir, env)) ev.add(G.scanCommits(s, dir, ['HEAD'], { env }).findings);
  }
  if (op.group === 'pr' && op.sub === 'create') {
    // gh pr create pushes the branch itself when it is not pushed yet, and
    // --fill copies commit messages into the PR, so outgoing commits count.
    const info = G.repoInfo(op.dir, { env });
    if (info && G.hasHead(op.dir, env)) ev.add(G.scanCommits(s, op.dir, ['HEAD', '--not', '--remotes'], { env }).findings);
  }
}

function evalOpaque(op, ev) {
  const env = ev.gitEnv();
  const info = G.repoInfo(op.dir, { env });
  if (!info || !G.repoIsProtected(info, ev.config, env)) return;
  ev.protect(describeRepo(info, env));
  ev.scanner();
}

// --- MCP tools ---------------------------------------------------------------

function collectStrings(value, path, out) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
  return out;
}

function mcpOwner(input, env) {
  if (typeof input?.owner === 'string' && input.owner) return input.owner;
  for (const key of ['repo', 'repository', 'full_name', 'repo_full_name']) {
    const v = input?.[key];
    if (typeof v === 'string' && v.includes('/')) return parseGhRepoArg(v, env)?.owner ?? null;
  }
  for (const key of ['url', 'html_url', 'repository_url']) {
    const v = input?.[key];
    if (typeof v === 'string') {
      const m = /github\.com\/([^/]+)\//.exec(v);
      if (m) return m[1];
    }
  }
  return null;
}

function evalMcp(toolName, toolInput, ev) {
  const action = toolName.split('__').pop() ?? '';
  if (/^(get|list|search|read|download|view|fetch|check)([_-]|$)/i.test(action)) return false;
  const owner = mcpOwner(toolInput, ev.env);
  if (owner && !ev.isProtected(owner)) return false;
  ev.protect(owner ?? 'your GitHub account');
  const s = ev.scanner();
  for (const [path, value] of collectStrings(toolInput, '', [])) {
    ev.add(s.message(value, `${action} ${path}`));
    for (const d of decodedBase64(value)) ev.add(s.message(d, `${action} ${path} (base64-decoded)`));
  }
  return true;
}

// --- Entry point ---------------------------------------------------------------

function deny(reason) {
  return { decision: 'deny', reason };
}

function report(ev) {
  const s = ev.scanner();
  const findings = dedupe(ev.findings);
  const where = [...ev.targets].join(', ');
  const lines = formatReport(findings, s, { limit: 25 });
  const reason = [
    `publish-guard blocked this: it publishes to ${where}, a protected GitHub owner, and would leak:`,
    ...lines.map((l) => `- ${l}`),
    'Remove the private text (███ marks each match; the term list is private and never shown) or fix the identity ' +
      '(git config user.email, --author, GIT_AUTHOR_EMAIL, or rewrite the commits), then retry. Do not work around this check.',
  ].join('\n');
  return deny(s.redact(reason));
}

// Decides a PreToolUse event. Returns null (no opinion: let Claude Code's
// normal permission flow run), { decision: 'deny', reason }, or
// { message } for a one-line notice to the user.
export function decide(input, options = {}) {
  // hooks.json gives the hook 120 seconds and Claude Code runs a command
  // whose hook timed out, so checking stops (and denies) well before that.
  G.setDeadline(Date.now() + (Number(options.env?.PUBLISH_GUARD_HOOK_BUDGET_MS ?? process.env.PUBLISH_GUARD_HOOK_BUDGET_MS) || 90_000));
  try {
    return decideNow(input, options);
  } finally {
    G.setDeadline(Infinity);
  }
}

function decideNow(input, { env = process.env, config: injected } = {}) {
  const tool = input?.tool_name ?? '';
  const toolInput = input?.tool_input ?? {};
  const cwd = input?.cwd || process.cwd();
  // Monitor runs a shell command too, so it gets the same treatment.
  const isBash = tool === 'Bash' || tool === 'Monitor';
  const isMcp = /^mcp__/.test(tool) && /github/i.test(tool);
  if (!isBash && !isMcp) return null;
  const command = isBash ? String(toolInput.command ?? '') : '';
  if (isBash && !MAYBE_PUBLISHING.test(command)) return null;

  let ops = [];
  if (isBash) {
    const walker = new Walker(cwd, env);
    try {
      walker.walk(command);
      ops = walker.ops;
    } catch {
      ops = [{ type: 'opaque', dir: cwd }];
    }
    if (!walker.sawTool && FALLBACK.test(command)) ops.push({ type: 'opaque', dir: cwd });
    if (!ops.some((o) => o.type !== 'git-add')) return null;
  }

  let config = injected;
  try {
    config ??= loadConfig({ env });
  } catch (err) {
    return deny(`publish-guard cannot check this publishing command: ${err instanceof GuardError ? err.message : 'config could not be loaded'}. Fix the config (see publish-guard init) and retry.`);
  }
  if (config.missing) {
    return { message: `publish-guard is installed but has no config at ${config.path}; run publish-guard init to protect your repositories.` };
  }

  const ev = new Evaluation({ config, env, command });
  try {
    if (isMcp) {
      if (!evalMcp(tool, toolInput, ev)) return null;
    } else {
      for (const op of ops) {
        if (op.type === 'git-add') evalAdd(op, ev);
        else if (op.type === 'git-commit') evalCommit(op, ev);
        else if (op.type === 'git-push') evalPush(op, ev);
        else if (op.type === 'gh') evalGh(op, ev);
        else if (op.type === 'opaque') evalOpaque(op, ev);
      }
      if (!ev.targets.size) return null;
      // Heredoc bodies, quoted messages and anything the parser misread all
      // live in the command string, so it is always scanned in full. Matches
      // already reported from a parsed message or body are not repeated.
      const known = new Set(ev.findings.map((f) => `${f.kind}:${f.ordinal ?? ''}:${f.excerpt ?? f.email ?? ''}`));
      ev.add(ev.scanner().message(command, 'command text').filter((f) => !known.has(`${f.kind}:${f.ordinal ?? ''}:${f.excerpt ?? f.email ?? ''}`)));
    }
  } catch (err) {
    const why = err instanceof GuardError ? err.message : `unexpected ${err?.name ?? 'error'}`;
    let safe = why;
    try {
      safe = ev.scanner().redact(why);
    } catch {
      // No terms could be loaded, so there is nothing to redact with. A
      // GuardError message is built from line numbers and paths only.
      if (!(err instanceof GuardError)) safe = 'the scanner failed';
    }
    return deny(`publish-guard could not finish checking a command that may publish to a protected GitHub owner (${safe}), so it is blocked. Fix the cause and retry.`);
  }
  if (!ev.findings.length) return null;
  return report(ev);
}

export function hookOutput(result) {
  if (!result) return '';
  if (result.decision === 'deny') {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason },
    });
  }
  if (result.message) return JSON.stringify({ systemMessage: result.message });
  return '';
}
