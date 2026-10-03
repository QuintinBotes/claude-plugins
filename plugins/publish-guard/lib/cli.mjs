// Command-line dispatch. Modules load lazily so the Claude Code hook, which
// runs before every Bash call, can decide "not publishing" without loading
// the scanner.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const USAGE = `publish-guard: keep private terms and work emails out of what you publish to GitHub.

Usage:
  publish-guard scan --text-file FILE | --stdin   scan text for private terms and emails
  publish-guard scan --git-staged                 staged changes and the commit identity
  publish-guard scan --git-range A..B             messages, identities and added lines in a range
  publish-guard scan --commit-msg-file FILE       a commit message (comment lines stripped)
  publish-guard audit [DIR] [--no-worktree] [--all]
                                                  every ref, message, identity, tag and file version
  publish-guard hook claude                       Claude Code PreToolUse hook (JSON on stdin)
  publish-guard hook git pre-commit|commit-msg|pre-push [ARGS]
  publish-guard install-git-hooks [REPO]          install the git hooks, chaining existing ones
  publish-guard init [--owner NAME]... [--email ADDRESS]...
                                                  create config and terms templates (never overwrites)
  publish-guard ci [DIR]                          GitHub Actions entry point (reusable workflow)

Options: --json prints findings as JSON (scan, audit).
Config: $PUBLISH_GUARD_CONFIG, else ~/.config/publish-guard/config.json.
Exit status: 0 clean, 1 findings or blocked, 2 usage or configuration error.
Matched terms are never printed: findings name the terms file line, and ███ marks each match.`;

const io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  if (value === undefined) throw new UsageError(`${name} needs a value`);
  return value;
}

function takeValues(args, name) {
  const values = [];
  for (let v = takeValue(args, name); v !== undefined; v = takeValue(args, name)) values.push(v);
  return values;
}

class UsageError extends Error {}

async function requireScanner() {
  const { loadConfig, scannerFor } = await import('./config.mjs');
  const config = loadConfig();
  if (config.missing) throw new UsageError(`no config at ${config.path}; run publish-guard init`);
  return { config, scanner: scannerFor(config) };
}

function jsonFindings(findings, scanner) {
  return findings.map((f) => ({
    kind: f.kind,
    where: scanner.redact(f.where),
    line: f.line,
    term: f.kind === 'term' ? { ordinal: f.ordinal, line: f.termLine } : undefined,
    excerpt: f.excerpt,
    email: f.email,
    rule: f.rule,
    message: f.message ? scanner.redact(f.message) : undefined,
  }));
}

async function printFindings(findings, scanner, json) {
  const { dedupe, formatReport } = await import('./scan.mjs');
  const all = dedupe(findings);
  if (json) {
    io.out(JSON.stringify({ findings: jsonFindings(all, scanner) }, null, 2));
  } else if (all.length) {
    for (const l of formatReport(all, scanner)) io.out(l);
    io.out(`${all.length} finding(s).`);
  } else {
    io.err('publish-guard: clean');
  }
  return all.length ? 1 : 0;
}

async function scan(args) {
  const json = takeFlag(args, '--json');
  const { scanner } = await requireScanner();
  const G = await import('./git.mjs');
  const cwd = process.cwd();
  const file = takeValue(args, '--text-file');
  const range = takeValue(args, '--git-range');
  const msgFile = takeValue(args, '--commit-msg-file');
  let findings;
  if (file !== undefined) {
    findings = scanner.message(readFileSync(file, 'utf8'), file);
  } else if (takeFlag(args, '--stdin')) {
    findings = scanner.message(readStdin(), 'stdin');
  } else if (takeFlag(args, '--git-staged')) {
    const env = G.gitEnv();
    findings = G.scanDiffFiles(scanner, G.stagedDiff(cwd, { env }), 'staged ');
    findings.push(...G.scanIdentities(scanner, G.effectiveIdentities(cwd, { env }), 'commit '));
  } else if (range !== undefined) {
    if (range.startsWith('-')) throw new UsageError('--git-range takes a revision range such as main..HEAD');
    findings = G.scanCommits(scanner, cwd, [range], { env: G.gitEnv() }).findings;
  } else if (msgFile !== undefined) {
    const { readCommitMessage } = await import('./githooks.mjs');
    findings = scanner.message(readCommitMessage(msgFile, cwd, G.gitEnv()), 'commit message');
  } else {
    throw new UsageError('scan needs --text-file, --stdin, --git-staged, --git-range or --commit-msg-file');
  }
  return printFindings(findings, scanner, json);
}

async function audit(args) {
  const json = takeFlag(args, '--json');
  const worktree = !takeFlag(args, '--no-worktree');
  const showAll = takeFlag(args, '--all');
  const dir = args[0] ?? process.cwd();
  const { scanner, config } = await requireScanner();
  const { audit: run, summarize } = await import('./audit.mjs');
  const { dedupe, formatReport } = await import('./scan.mjs');
  const { findings, stats } = run(dir, scanner, { worktree });
  const all = dedupe(findings);
  if (json) {
    io.out(JSON.stringify({ stats, findings: jsonFindings(all, scanner) }, null, 2));
    return all.length ? 1 : 0;
  }
  io.out(scanner.redact(`publish-guard audit of ${dir}`));
  io.out(
    `scanned ${stats.commits} commits (messages and identities), ${stats.tags} annotated tags, ` +
      `${stats.blobs} file versions across ${stats.paths} paths` +
      (worktree ? `, ${stats.worktree} changed working-tree files` : '') +
      (stats.skipped ? `, skipped ${stats.skipped} blobs over 32 MiB` : '') +
      `; ${scanner.terms.length} terms from ${config.termsFile.replace(/^.*\//, '')}`,
  );
  if (!all.length) {
    io.out('clean: no private terms and no disallowed emails found');
    return 0;
  }
  io.out('\nSummary (one line per commit, tag, file or path):');
  for (const g of summarize(all)) {
    const parts = [];
    if (g.terms.size) parts.push(`terms on ${scanner.termsLabel} lines ${[...g.terms.keys()].sort((a, b) => a - b).join(', ')}`);
    if (g.emails) parts.push(`${g.emails} disallowed email(s)`);
    if (g.errors) parts.push(`${g.errors} error(s)`);
    if (g.versions.size > 1) parts.push(`in ${g.versions.size} versions`);
    io.out(scanner.redact(`  ${g.group}: ${parts.join('; ')}`));
  }
  const limit = showAll ? Infinity : 100;
  io.out(`\nDetails${all.length > limit ? ` (first ${limit}; --all shows every one)` : ''}:`);
  for (const l of formatReport(all, scanner, { limit })) io.out(`  ${l}`);
  io.out(`\n${all.length} finding(s).`);
  return 1;
}

async function hookClaude() {
  const raw = readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 0;
  }
  const claude = await import('./claude.mjs');
  const tool = input?.tool_name ?? '';
  if ((tool === 'Bash' || tool === 'Monitor') && !claude.MAYBE_PUBLISHING.test(String(input?.tool_input?.command ?? ''))) return 0;
  let result;
  try {
    result = claude.decide(input);
  } catch {
    // A crash must not let a publishing command through unchecked.
    result = { decision: 'deny', reason: 'publish-guard failed while checking a git or gh command, so it is blocked. Run the command again; if this repeats, run publish-guard scan on the content by hand.' };
  }
  const out = claude.hookOutput(result);
  if (out) process.stdout.write(`${out}\n`);
  return 0;
}

async function hookGit(args) {
  const [hook, ...rest] = args;
  const { runGitHook, HOOK_NAMES } = await import('./githooks.mjs');
  if (!HOOK_NAMES.includes(hook)) throw new UsageError(`hook git takes one of ${HOOK_NAMES.join(', ')}`);
  return runGitHook(hook, rest, { stdin: hook === 'pre-push' ? readStdin() : '', io });
}

async function installHooks(args) {
  const { installGitHooks } = await import('./githooks.mjs');
  const binPath = realpathSync(fileURLToPath(new URL('../bin/publish-guard', import.meta.url)));
  return installGitHooks(args[0] ?? process.cwd(), { binPath, io });
}

async function initCmd(args) {
  const { init } = await import('./init.mjs');
  return init({ owners: takeValues(args, '--owner'), emails: takeValues(args, '--email'), io });
}

async function ci(args) {
  const { runCi } = await import('./ci.mjs');
  return runCi(args[0] ?? process.cwd(), { io });
}

export async function main(argv) {
  const args = [...argv];
  const cmd = args.shift();
  try {
    switch (cmd) {
      case 'scan':
        return await scan(args);
      case 'audit':
        return await audit(args);
      case 'hook':
        if (args[0] === 'claude') return await hookClaude();
        if (args[0] === 'git') return await hookGit(args.slice(1));
        throw new UsageError('hook takes claude or git');
      case 'install-git-hooks':
        return await installHooks(args);
      case 'init':
        return await initCmd(args);
      case 'ci':
        return await ci(args);
      case '--version':
      case 'version': {
        const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
        io.out(manifest.version);
        return 0;
      }
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        io.out(USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (err) {
    const { GuardError } = await import('./util.mjs');
    if (err instanceof UsageError || err instanceof GuardError) {
      const { redactLoaded } = await import('./config.mjs');
      io.err(`publish-guard: ${redactLoaded(err.message)}`);
      if (err instanceof UsageError) io.err('Run publish-guard --help for usage.');
      return 2;
    }
    // Unknown errors can carry text (a file path, a git message), so only
    // the type is shown.
    io.err(`publish-guard: unexpected ${err?.name ?? 'error'}; nothing was checked`);
    if (process.env.PUBLISH_GUARD_DEBUG === '1') io.err(err?.stack ?? String(err));
    return 2;
  }
}
