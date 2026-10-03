import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { commit, containsTerm, git, makeRepo, ME, run, setup, TERMS, WORK } from './helpers.mjs';

const ZERO = '0'.repeat(40);

function ciEnv(env, extra) {
  const termsFile = join(env.HOME, 'ci-terms.txt');
  writeFileSync(termsFile, TERMS, { mode: 0o600 });
  const out = { ...env, GUARD_TERMS_FILE: termsFile, GUARD_ALLOWED_EMAILS: `${ME}, other@personal.example`, ...extra };
  delete out.PUBLISH_GUARD_CONFIG;
  return out;
}

test('ci: push range is checked for terms and identities', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const base = commit(dir, env, 'a.txt', 'one\n', 'Initial');
  const after = commit(dir, env, 'b.txt', 'see acme-internal wiki\n', 'Second');
  const res = run(['ci', dir], { env: ciEnv(env, { GUARD_EVENT: 'push', GUARD_BEFORE: base, GUARD_AFTER: after, GUARD_REF: 'refs/heads/main' }) });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /checked 1 commit/);
  assert.match(res.stdout, /b\.txt, line 1: private term #1 \(ci-terms\.txt line 3\)/);
  assert.match(res.stdout, /::error title=publish-guard::/);
  assert.ok(!containsTerm(res.stdout + res.stderr));
});

test('ci: zero before-SHA scans what no other branch has', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const base = commit(dir, env, 'a.txt', 'one\n', 'Initial', { GIT_AUTHOR_EMAIL: WORK });
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, env, 'checkout', '-q', '-b', 'feature');
  const after = commit(dir, env, 'b.txt', 'two\n', 'Feature');
  git(dir, env, 'update-ref', 'refs/remotes/origin/feature', after);
  const res = run(['ci', dir], { env: ciEnv(env, { GUARD_EVENT: 'push', GUARD_BEFORE: ZERO, GUARD_AFTER: after, GUARD_REF: 'refs/heads/feature' }) });
  // The work-email commit is already on main, so only "Feature" is new.
  assert.equal(res.code, 0, res.stdout);
  assert.match(res.stdout, /checked 1 commit/);
});

test('ci: without the secret, identities are still checked and the log says terms were not', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const base = commit(dir, env, 'a.txt', 'one\n', 'Initial');
  const head = commit(dir, env, 'b.txt', 'AcmeWidget\n', 'Second', { GIT_AUTHOR_EMAIL: WORK });
  const e = ciEnv(env, { GUARD_EVENT: 'pull_request', GUARD_PR_BASE: base, GUARD_PR_HEAD: head, GUARD_PR_ASSOCIATION: 'CONTRIBUTOR', GUARD_PR_TITLE: 'AcmeWidget' });
  delete e.GUARD_TERMS_FILE;
  const res = run(['ci', dir], { env: e });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /private terms were NOT checked/);
  assert.match(res.stdout, /author: email d\*\*\*@corp-mail\.io/);
  assert.doesNotMatch(res.stdout, /private term #/);
});

test('ci: text by non-collaborators is never checked against terms', () => {
  const { env } = setup();
  const issue = (assoc) =>
    run(['ci', env.HOME], { env: ciEnv(env, { GUARD_EVENT: 'issue_comment', GUARD_COMMENT_BODY: 'is this acme corp?', GUARD_COMMENT_ASSOCIATION: assoc }) });
  const outsider = issue('NONE');
  assert.equal(outsider.code, 0);
  assert.match(outsider.stdout, /cannot be used to probe them/);
  const owner = issue('OWNER');
  assert.equal(owner.code, 1);
  assert.match(owner.stdout, /comment, line 1: private term #3/);
  assert.ok(!containsTerm(owner.stdout));
});

test('audit finds leaks in history, tags and removed files without printing terms', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, 'notes.md', 'Kickoff with the acme-internal team\n', 'Add notes');
  writeFileSync(join(dir, 'notes.md'), 'Kickoff\n');
  git(dir, env, 'commit', '-q', '-am', 'Scrub notes');
  commit(dir, env, 'b.txt', 'x\n', 'Merge AcmeWidget work', { GIT_AUTHOR_EMAIL: WORK });
  git(dir, env, 'tag', '-a', 'v1', '-m', 'Release for acme corp');
  writeFileSync(join(dir, 'draft.md'), 'AcmeWidget draft\n');

  const res = run(['audit', dir], { env });
  assert.equal(res.code, 1);
  const out = res.stdout + res.stderr;
  assert.ok(!containsTerm(out), out);
  assert.match(out, /scanned 3 commits/);
  assert.match(out, /file notes\.md: terms on terms\.txt lines 3/);
  assert.match(out, /tag v1: terms on terms\.txt lines 5/);
  assert.match(out, /commit [0-9a-f]{10}: terms on terms\.txt lines 4; 1 disallowed email/);
  assert.match(out, /worktree draft\.md/);

  const clean = makeRepo(env);
  commit(clean, env, 'a.md', 'fine\n', 'fine');
  const ok = run(['audit', clean], { env });
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /clean/);
});

test('init creates private templates and never overwrites', () => {
  const { env } = setup();
  const e = { ...env, PUBLISH_GUARD_CONFIG: join(env.HOME, 'fresh', 'config.json') };
  const res = run(['init', '--owner', 'octo-owner', '--email', ME], { env: e });
  assert.equal(res.code, 0, res.stderr);
  const cfg = JSON.parse(readFileSync(e.PUBLISH_GUARD_CONFIG, 'utf8'));
  assert.deepEqual(cfg.protected_owners, ['octo-owner']);
  assert.equal(statSync(e.PUBLISH_GUARD_CONFIG).mode & 0o777, 0o600);
  assert.equal(statSync(cfg.terms_file).mode & 0o777, 0o600);
  writeFileSync(cfg.terms_file, 'acme-internal\n');
  const again = run(['init'], { env: e });
  assert.match(again.stdout, /kept existing/);
  assert.equal(readFileSync(cfg.terms_file, 'utf8'), 'acme-internal\n');
});

test('ci: error messages that quote git output are redacted', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, 'a.txt', 'one\n', 'Initial');
  const res = run(['ci', dir], { env: ciEnv(env, { GUARD_EVENT: 'push', GUARD_BEFORE: '', GUARD_AFTER: 'acme-internal', GUARD_REF: 'refs/heads/main' }) });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /git log failed/);
  assert.ok(!containsTerm(res.stdout + res.stderr), res.stderr);
});

test('ci: a wrapped term in a pull request body is found and no fragment is printed', () => {
  const { env } = setup();
  const res = run(['ci', env.HOME], { env: ciEnv(env, { GUARD_EVENT: 'issues', GUARD_ISSUE_ASSOCIATION: 'OWNER', GUARD_ISSUE_BODY: 'Details:\nwe moved the acme\ncorp exporter\n' }) });
  assert.equal(res.code, 1);
  assert.match(res.stdout, /issue body, line 2: private term #3/);
  assert.doesNotMatch(res.stdout, /acme/i);
});
