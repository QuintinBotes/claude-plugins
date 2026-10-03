// Full-history audit: every commit message and identity on every ref, every
// annotated tag, every version of every file (and every path name) that any
// ref can reach, plus uncommitted work in the working tree. Use it to find
// what already leaked before cleaning a repository up.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as G from './git.mjs';
import { isBinary, readTextFile } from './util.mjs';

const BATCH = 1000;
const MAX_BLOB = 32 * 1024 * 1024;

function catFileBatch(dir, shas, env) {
  const res = spawnSync('git', ['cat-file', '--batch'], { cwd: dir, env, input: `${shas.join('\n')}\n`, maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (res.status !== 0) throw new Error('git cat-file --batch failed');
  const out = res.stdout;
  const blobs = new Map();
  let i = 0;
  while (i < out.length) {
    const nl = out.indexOf(0x0a, i);
    const header = out.subarray(i, nl).toString('utf8');
    const [sha, type, size] = header.split(' ');
    if (type === 'missing' || size === undefined) {
      i = nl + 1;
      continue;
    }
    const n = Number(size);
    blobs.set(sha, out.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return blobs;
}

// blob sha -> first commit (oldest first) that added it, from one log pass.
function blobOrigins(dir, env) {
  const out = G.git(['log', '--all', '--reverse', '--format=%x1e%h', '--raw', '--no-abbrev', '--no-renames'], { cwd: dir, env });
  const origin = new Map();
  for (const rec of out.split('\x1e')) {
    const nl = rec.indexOf('\n');
    if (nl === -1) continue;
    const commit = rec.slice(0, nl).trim().slice(0, 10);
    for (const line of rec.slice(nl + 1).split('\n')) {
      const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [A-Z]/.exec(line);
      if (m && !origin.has(m[1])) origin.set(m[1], commit);
    }
  }
  return origin;
}

export function audit(dir, scanner, { env = G.gitEnv(), worktree = true } = {}) {
  const info = G.repoInfo(dir, { env });
  if (!info) throw new Error(`${dir} is not a git repository`);
  const findings = [];
  const stats = { commits: 0, tags: 0, blobs: 0, paths: 0, worktree: 0, skipped: 0 };

  if (G.git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir, env, allowFail: true }) !== null ||
      G.listRefs(dir, [], env).length) {
    const commits = G.scanCommits(scanner, dir, ['--all'], { env, withPatch: false });
    stats.commits = commits.commits;
    for (const f of commits.findings) findings.push({ ...f, group: `commit ${f.where.split(' ')[1]}` });
  }

  for (const ref of G.listRefs(dir, ['refs/tags/'], env)) {
    if (ref.type !== 'tag') continue;
    stats.tags++;
    const name = ref.name.slice(10);
    for (const f of G.scanTagObject(scanner, dir, ref.sha, name, env)) findings.push({ ...f, group: `tag ${name}` });
  }

  // Every blob reachable from any ref, with the first path it was seen at.
  const listing = G.git(['rev-list', '--all', '--objects', '--filter=object:type=blob', '--filter-provided-objects'], { cwd: dir, env, allowFail: true }) ??
    G.git(['rev-list', '--all', '--objects'], { cwd: dir, env });
  const blobs = new Map();
  const paths = new Set();
  for (const line of listing.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (!path) continue;
    paths.add(path);
    if (!blobs.has(sha)) blobs.set(sha, path);
  }
  // Without --filter support the listing includes trees; cat-file tells.
  const shas = [...blobs.keys()];
  const blobFindings = [];
  for (let i = 0; i < shas.length; i += BATCH) {
    const contents = catFileBatch(dir, shas.slice(i, i + BATCH), env);
    for (const [sha, buf] of contents) {
      const path = blobs.get(sha);
      if (buf.length > MAX_BLOB) {
        stats.skipped++;
        continue;
      }
      stats.blobs++;
      const binary = isBinary(buf);
      for (const f of scanner.text(buf.toString('utf8'), `blob ${path}`, { emails: binary ? 'none' : 'content' })) {
        blobFindings.push({ ...f, sha, path });
      }
    }
  }
  stats.paths = paths.size;
  for (const p of paths) {
    for (const f of scanner.text(p, `path ${p}`, { emails: 'none', numbered: false })) findings.push({ ...f, group: `path ${p}` });
  }
  if (blobFindings.length) {
    const origins = blobOrigins(dir, env);
    for (const f of blobFindings) {
      const commit = origins.get(f.sha) ?? 'a merge';
      findings.push({ ...f, where: `${f.where} (blob ${f.sha.slice(0, 10)}, added in ${commit})`, group: `file ${f.path}` });
    }
  }

  if (worktree && !info.bare) {
    const top = G.topLevel(dir, env);
    const status = G.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: top, env });
    const entries = status.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      const code = e.slice(0, 2);
      const path = e.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++;
      if (code.includes('D')) continue;
      const res = readTextFile(join(top, path));
      stats.worktree++;
      for (const f of scanner.text(path, `worktree ${path} (path)`, { emails: 'none', numbered: false })) findings.push({ ...f, group: `worktree ${path}` });
      if (res.text === undefined) continue;
      for (const f of scanner.text(res.text, `worktree ${path}`)) findings.push({ ...f, group: `worktree ${path}` });
    }
  }
  return { findings, stats };
}

// Groups findings for the summary: one line per commit / file / tag.
export function summarize(findings) {
  const groups = new Map();
  for (const f of findings) {
    const g = groups.get(f.group) ?? { group: f.group, terms: new Map(), emails: 0, errors: 0, versions: new Set() };
    if (f.kind === 'term') g.terms.set(f.termLine, (g.terms.get(f.termLine) ?? 0) + 1);
    else if (f.kind === 'email') g.emails++;
    else g.errors++;
    if (f.sha) g.versions.add(f.sha);
    groups.set(f.group, g);
  }
  return [...groups.values()];
}
