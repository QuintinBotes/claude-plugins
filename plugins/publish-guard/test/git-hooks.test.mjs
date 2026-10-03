import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { commit, containsTerm, git, makeRepo, run, setup, tempDir, WORK } from './helpers.mjs';

const ZERO = '0'.repeat(40);

function gitRaw(cwd, env, ...args) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

test('install-git-hooks installs, chains an existing hook, and is idempotent', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const hooks = join(dir, '.git', 'hooks');
  const marker = join(dir, 'local-ran');
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });

  const first = run(['install-git-hooks', dir], { env });
  assert.equal(first.code, 0, first.stderr);
  for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
    assert.ok(statSync(join(hooks, name)).mode & 0o100, `${name} executable`);
  }
  assert.match(readFileSync(join(hooks, 'pre-commit.local'), 'utf8'), /local-ran/);
  assert.match(first.stdout, /kept the existing pre-commit hook as pre-commit\.local/);

  const again = run(['install-git-hooks', dir], { env });
  assert.equal(again.code, 0);
  assert.match(again.stdout, /updated .*pre-commit/);
  assert.match(readFileSync(join(hooks, 'pre-commit.local'), 'utf8'), /local-ran/);

  // The chained hook still runs after a clean guard pass.
  writeFileSync(join(dir, 'a.md'), 'clean\n');
  git(dir, env, 'add', 'a.md');
  git(dir, env, 'commit', '-q', '-m', 'clean commit');
  assert.ok(existsSync(marker));
});

test('install-git-hooks refuses when core.hooksPath is set', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  git(dir, env, 'config', 'core.hooksPath', '.husky/_');
  const res = run(['install-git-hooks', dir], { env });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /core\.hooksPath is set to \.husky\/_/);
  assert.match(res.stderr, /hook git pre-push/);
  assert.ok(!existsSync(join(dir, '.git', 'hooks', 'pre-push')));
});

test('installed pre-commit and commit-msg hooks block leaks in protected repos', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  assert.equal(run(['install-git-hooks', dir], { env }).code, 0);

  writeFileSync(join(dir, 'README.md'), 'Built for AcmeWidget\n');
  git(dir, env, 'add', 'README.md');
  let res = gitRaw(dir, env, 'commit', '-m', 'docs');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /pre-commit blocked for octo-owner\/project/);
  assert.match(res.stderr, /staged README\.md, line 1: private term #2/);
  assert.ok(!containsTerm(res.stderr));

  writeFileSync(join(dir, 'README.md'), 'clean\n');
  git(dir, env, 'add', 'README.md');
  res = gitRaw(dir, env, 'commit', '-m', 'Notes from the acme-internal sync');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /commit-msg blocked/);
  assert.ok(!containsTerm(res.stderr));

  res = gitRaw(dir, { ...env, GIT_AUTHOR_EMAIL: WORK }, 'commit', '-m', 'clean');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /commit author: email d\*\*\*@corp-mail\.io/);

  res = gitRaw(dir, env, 'commit', '-m', 'clean\n\n# comment lines like acme-internal are stripped by git');
  assert.equal(res.status, 0, res.stderr);
});

test('hooks do nothing in repos of other owners', () => {
  const { env } = setup();
  const dir = makeRepo(env, { remote: 'https://github.com/client-owner/app.git' });
  assert.equal(run(['install-git-hooks', dir], { env }).code, 0);
  writeFileSync(join(dir, 'README.md'), 'Built for AcmeWidget\n');
  git(dir, env, 'add', 'README.md');
  const res = gitRaw(dir, { ...env, GIT_AUTHOR_EMAIL: WORK }, 'commit', '-m', 'acme-internal notes');
  assert.equal(res.status, 0, res.stderr);
});

test('pre-push checks new branches, existing branches and skips deletes', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const base = commit(dir, env, 'a.txt', 'one\n', 'Initial');
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', base);
  const bad = commit(dir, env, 'b.txt', 'two\n', 'Talk to acme corp');
  const url = 'https://github.com/octo-owner/project.git';
  const hook = (stdin, u = url) => run(['hook', 'git', 'pre-push', 'origin', u], { env, cwd: dir, input: stdin });

  let res = hook(`refs/heads/main ${bad} refs/heads/main ${base}\n`);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /message, line 1: private term #3/);
  assert.ok(!containsTerm(res.stderr));

  res = hook(`refs/heads/feature ${bad} refs/heads/feature ${ZERO}\n`);
  assert.equal(res.code, 1, 'new branch: commits not on the remote are outgoing');

  assert.equal(hook(`(delete) ${ZERO} refs/heads/old ${base}\n`).code, 0);
  assert.equal(hook(`refs/heads/main ${base} refs/heads/main ${base}\n`).code, 0);
  assert.equal(hook(`refs/heads/main ${bad} refs/heads/main ${base}\n`, 'git@github.com:client-owner/app.git').code, 0);
});

test('a real git push runs the pre-push hook (local remote forced to protected)', () => {
  const { env } = setup();
  const bare = tempDir('pg-bare-');
  git(bare, env, 'init', '-q', '--bare');
  const dir = makeRepo(env, { remote: bare });
  git(dir, env, 'config', 'publish-guard.protect', 'true');
  assert.equal(run(['install-git-hooks', dir], { env }).code, 0);
  commit(dir, env, 'a.txt', 'one\n', 'Initial');
  let res = gitRaw(dir, env, 'push', '-q', 'origin', 'main');
  assert.equal(res.status, 0, res.stderr);
  commit(dir, env, 'b.txt', 'AcmeWidget\n', 'Second');
  res = gitRaw(dir, env, 'push', '-q', 'origin', 'main');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /pre-push blocked/);
  assert.match(res.stderr, /b\.txt, line 1/);
});

test('a missing guard binary fails closed with instructions', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  assert.equal(run(['install-git-hooks', dir], { env }).code, 0);
  writeFileSync(join(dir, 'a.md'), 'x\n');
  git(dir, env, 'add', 'a.md');
  const res = gitRaw(dir, { ...env, PUBLISH_GUARD_BIN: join(dir, 'gone') }, 'commit', '-m', 'x');
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /re-run publish-guard install-git-hooks/i);
});

test('pre-commit sees through .gitattributes that mark text as binary', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, '.gitattributes', 'notes.md -diff\n*.lock binary\n', 'attrs');
  writeFileSync(join(dir, 'notes.md'), 'AcmeWidget\n');
  git(dir, env, 'add', 'notes.md');
  const res = run(['hook', 'git', 'pre-commit'], { env, cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /staged notes\.md, line 1: private term #2/);
});
