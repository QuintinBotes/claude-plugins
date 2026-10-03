import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { claudeHook, commit, containsTerm, git, makeRepo, ME, setup, WORK } from './helpers.mjs';

const PR_WITH_TERM = `gh pr create --title "Add widget support" --body "$(cat <<'EOF'
## Summary
- Ports the AcmeWidget renderer
- Don't panic

Generated with Claude Code
EOF
)"`;

function assertDenied(res, pattern) {
  assert.ok(res.deny, `expected deny, got: ${res.raw}`);
  assert.equal(res.code, 0);
  assert.ok(!containsTerm(res.raw), `output leaked a term: ${res.raw}`);
  if (pattern) assert.match(res.reason, pattern);
}

function assertSilent(res) {
  assert.equal(res.code, 0, res.raw);
  assert.equal(res.raw.trim(), '', `expected no output, got: ${res.raw}`);
}

test('plain ls passes untouched and fast', () => {
  const { env } = setup();
  const res = claudeHook('ls -la', { env, cwd: env.HOME });
  assertSilent(res);
  assert.ok(res.ms < 1000, `took ${res.ms}ms`);
});

test('gh pr create with a heredoc body containing a term is denied in a protected repo', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, 'a.txt', 'hello\n', 'init');
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const res = claudeHook(PR_WITH_TERM, { env, cwd: dir });
  assertDenied(res, /private term #2 \(terms\.txt line 4\)/);
  assert.match(res.reason, /octo-owner/);
});

test('the same gh pr create passes for a repo of another owner', () => {
  const { env } = setup();
  const dir = makeRepo(env, { remote: 'git@github.com:client-owner/app.git' });
  commit(dir, env, 'a.txt', 'hello\n', 'init');
  assertSilent(claudeHook(PR_WITH_TERM, { env, cwd: dir }));
});

test('gh -R pointing at a protected repo is denied even from an unrelated directory', () => {
  const { env } = setup();
  const res = claudeHook(`gh issue create -R octo-owner/project --title "acme corp request" --body ok`, { env, cwd: env.HOME });
  assertDenied(res, /terms\.txt line 5/);
});

test('git commit -m with a clean message and clean staged change passes', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'notes.md'), 'nothing private\n');
  git(dir, env, 'add', 'notes.md');
  assertSilent(claudeHook('git commit -m "Add notes"', { env, cwd: dir }));
});

test('git commit with a term in the message is denied', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'notes.md'), 'nothing private\n');
  git(dir, env, 'add', 'notes.md');
  const res = claudeHook(`git commit -m "$(cat <<'EOF'\nPort acme-internal tooling\nEOF\n)"`, { env, cwd: dir });
  assertDenied(res, /commit message/);
});

test('git add + commit in one call checks the files being added', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'CHANGELOG.md'), '## 1.0\n- Works with AcmeWidget\n');
  const res = claudeHook('git add CHANGELOG.md && git commit -m "Release notes"', { env, cwd: dir });
  assertDenied(res, /CHANGELOG\.md, line 2/);
});

test('git commit with a non-allowed author email in the command is denied', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'a.md'), 'x\n');
  git(dir, env, 'add', 'a.md');
  assertDenied(claudeHook(`GIT_AUTHOR_EMAIL=${WORK} git commit -m "x"`, { env, cwd: dir }), /author: email d\*\*\*@corp-mail\.io/);
  assertDenied(claudeHook(`git -c user.email=${WORK} commit -m "x"`, { env, cwd: dir }), /committer/);
  assertDenied(claudeHook(`git commit --author="Me <${WORK}>" -m "x"`, { env, cwd: dir }), /author/);
});

test('git push with an outgoing commit whose message has a term is denied', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, 'a.txt', 'one\n', 'Initial commit');
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assertSilent(claudeHook('git push', { env, cwd: dir }));
  commit(dir, env, 'b.txt', 'two\n', 'Wire up the Acme.Corp exporter');
  assertDenied(claudeHook('git push', { env, cwd: dir }), /commit [0-9a-f]{10} message/);
  assertDenied(claudeHook('git push -u origin main', { env, cwd: dir }));
  assertDenied(claudeHook(`cd ${dir} && git push origin HEAD:refs/heads/feature`, { env, cwd: env.HOME }));
  // Once the commit is on the remote it is no longer outgoing.
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assertSilent(claudeHook('git push', { env, cwd: dir }));
});

test('git push with an outgoing commit by a non-allowed email is denied', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, 'a.txt', 'one\n', 'Initial commit');
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit(dir, env, 'b.txt', 'two\n', 'Clean message', { GIT_AUTHOR_EMAIL: WORK, GIT_COMMITTER_EMAIL: WORK });
  const res = claudeHook('git push origin main', { env, cwd: dir });
  assertDenied(res, /author: email d\*\*\*@corp-mail\.io is not an allowed commit identity/);
});

test('git push of a term to another owner passes', () => {
  const { env } = setup();
  const dir = makeRepo(env, { remote: 'https://github.com/client-owner/app.git' });
  commit(dir, env, 'a.txt', 'AcmeWidget\n', 'AcmeWidget support');
  assertSilent(claudeHook('git push origin main', { env, cwd: dir }));
});

test('a first push to a protected remote checks the whole history', () => {
  const { env } = setup();
  const dir = makeRepo(env, { remote: 'https://github.com/client-owner/app.git' });
  commit(dir, env, 'a.txt', 'built for acme-internal\n', 'Initial');
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, env, 'remote', 'add', 'mine', 'git@github.com:octo-owner/app.git');
  assertDenied(claudeHook('git push mine main', { env, cwd: dir }), /a\.txt, line 1/);
});

test('gh pr merge needs an allowed --author-email for squash merges', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  assertDenied(claudeHook('gh pr merge 12 --squash', { env, cwd: dir }), /--author-email/);
  assertDenied(claudeHook(`gh pr merge 12 --squash --author-email ${WORK}`, { env, cwd: dir }), /not an allowed/);
  assertSilent(claudeHook(`gh pr merge 12 --squash --author-email ${ME}`, { env, cwd: dir }));
  assertSilent(claudeHook('gh pr merge 12 --rebase', { env, cwd: dir }));
});

test('body files are read and stdin pipes from unknown programs fail closed', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'body.md'), 'Thanks to the acme-internal team\n');
  assertDenied(claudeHook('gh issue comment 3 --body-file body.md', { env, cwd: dir }), /body-file/);
  assertDenied(claudeHook('gh issue comment 3 --body-file missing.md', { env, cwd: dir }), /does not exist yet/);
  assertDenied(claudeHook('generate-notes | gh release create v1 --notes-file -', { env, cwd: dir }), /stdin/);
  assertSilent(claudeHook(`cat > notes.md <<'EOF'\nclean notes\nEOF\ngh release create v1 --notes-file notes.md`, { env, cwd: dir }));
});

test('gh api writes are checked; reads are not', () => {
  const { env } = setup();
  assertDenied(claudeHook(`gh api repos/octo-owner/project/issues -f title="acme corp" -f body=x`, { env, cwd: env.HOME }));
  assertSilent(claudeHook(`gh api repos/client-owner/app/issues -f title="acme corp"`, { env, cwd: env.HOME }));
  assertSilent(claudeHook(`gh api "search/issues?q=acme corp"`, { env, cwd: env.HOME }));
  assertDenied(claudeHook(`gh gist create notes.txt --desc "AcmeWidget notes"`, { env, cwd: env.HOME }));
});

test('gh repo create --push checks the history it publishes', () => {
  const { env } = setup();
  const dir = makeRepo(env, { remote: null });
  commit(dir, env, 'a.txt', 'one\n', 'Notes from acme-internal');
  assertDenied(claudeHook('gh repo create octo-owner/fresh --public --source=. --push', { env, cwd: dir }), /message, line 1/);
  assertSilent(claudeHook('gh repo create client-owner/fresh --private --source=. --push', { env, cwd: dir }));
});

test('wrappers and nested shells are seen through', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  assertDenied(claudeHook(`bash -c 'gh pr comment 1 --body "acme-internal"'`, { env, cwd: dir }));
  assertDenied(claudeHook(`env FOO=1 command gh pr comment 1 --body "acme-internal"`, { env, cwd: dir }));
  assertDenied(claudeHook(`eval "gh pr comment 1 --body acme-internal"`, { env, cwd: dir }));
});

test('GitHub MCP writes are scanned by owner; reads pass', () => {
  const { env } = setup();
  const input = (owner) => ({ owner, repo: 'project', title: 'Bug', body: 'Seen in AcmeWidget' });
  assertDenied(claudeHook(null, { env, cwd: env.HOME, tool: 'mcp__github__create_issue', toolInput: input('octo-owner') }));
  assertSilent(claudeHook(null, { env, cwd: env.HOME, tool: 'mcp__github__create_issue', toolInput: input('client-owner') }));
  assertSilent(claudeHook(null, { env, cwd: env.HOME, tool: 'mcp__github__search_issues', toolInput: { q: 'AcmeWidget' } }));
});

test('missing config only notifies; broken config fails closed for publishing only', () => {
  const { env, configPath } = setup();
  const dir = makeRepo(env);
  const missing = claudeHook('git push', { env: { ...env, PUBLISH_GUARD_CONFIG: join(env.HOME, 'none.json') }, cwd: dir });
  assert.ok(!missing.deny);
  assert.match(missing.parsed?.systemMessage ?? '', /publish-guard init/);
  writeFileSync(configPath, '{ not json');
  assertDenied(claudeHook('git push', { env, cwd: dir }), /not valid JSON/);
  assertSilent(claudeHook('ls', { env, cwd: dir }));
});

test('an unreadable terms file fails closed for protected repos', () => {
  const { env, termsFile } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'a.md'), 'x\n');
  git(dir, env, 'add', 'a.md');
  writeFileSync(termsFile, 're:(unclosed\n');
  assertDenied(claudeHook('git commit -m ok', { env, cwd: dir }), /line 1: invalid regular expression/);
});

test('the hook never answers allow', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'a.md'), 'x\n');
  git(dir, env, 'add', 'a.md');
  for (const cmd of ['git status', 'git commit -m ok', 'gh pr view 1', 'echo git push']) {
    const res = claudeHook(cmd, { env, cwd: dir });
    assert.ok(!res.allowField, cmd);
  }
});

test('a term wrapped across lines or written with a Unicode dash is denied without showing a fragment', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const wrapped = claudeHook(`gh pr create --title t --body "$(cat <<'EOF'\nWe ported the acme\ncorp exporter\nEOF\n)"`, { env, cwd: dir });
  assertDenied(wrapped, /terms\.txt line 5/);
  assert.doesNotMatch(wrapped.reason, /acme/i);
  assertDenied(claudeHook(`gh pr comment 1 --body "acme${String.fromCharCode(0x2011)}internal"`, { env, cwd: dir }), /terms\.txt line 3/);
  writeFileSync(join(dir, 'wrapped.md'), 'see acme\ncorp\n');
  git(dir, env, 'add', 'wrapped.md');
  assertDenied(claudeHook('git commit -m ok', { env, cwd: dir }), /staged wrapped\.md, line 1/);
});

test('text pulled in by $(cat FILE), /dev/stdin and same-command copies is checked', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  writeFileSync(join(dir, 'body.md'), 'Thanks acme-internal\n');
  assertDenied(claudeHook('gh pr create --title t --body "$(cat body.md)"', { env, cwd: dir }), /command substitution .*body\.md/);
  assertDenied(claudeHook('gh pr create --title t --body "$(< body.md)"', { env, cwd: dir }), /command substitution/);
  assertDenied(claudeHook('git commit --allow-empty -m "$(cat body.md)"', { env, cwd: dir }), /command substitution/);
  assertDenied(claudeHook('BODY="$(cat body.md)"; gh pr create --title t --body "$BODY"', { env, cwd: dir }), /command substitution/);
  assertDenied(claudeHook('cat body.md | gh pr create --title t --body-file /dev/stdin', { env, cwd: dir }), /body\.md, line 1/);
  assertDenied(claudeHook('cat body.md > out.md && gh pr create --title t --body-file out.md', { env, cwd: dir }), /copied from/);
  assertDenied(claudeHook('cp body.md "$HOME/out.md" && gh issue comment 1 --body-file "$HOME/out.md"', { env, cwd: dir }), /copied from/);
  // Output of a program the hook cannot read fails closed even over an old file.
  writeFileSync(join(dir, 'notes.md'), 'old clean notes\n');
  assertDenied(claudeHook('./make-notes > notes.md && gh release create v1 --notes-file notes.md', { env, cwd: dir }), /cannot read/);
  assertDenied(claudeHook('cat body.md | gh gist create', { env, cwd: dir }), /stdin/);
  assertDenied(claudeHook('gh gist edit abc123 --add body.md', { env, cwd: dir }), /--add/);
  assertSilent(claudeHook(`cat > clean.md <<'EOF'\nclean notes\nEOF\ngh release create v1 --notes-file clean.md`, { env, cwd: dir }));
});

test('every way of naming the target repository is followed', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const client = makeRepo(env, { remote: 'https://github.com/client-owner/app.git' });
  writeFileSync(join(dir, 'body.md'), 'Thanks acme-internal\n');
  const body = join(dir, 'body.md');
  assertDenied(claudeHook(`gh pr --repo octo-owner/project create --title t --body-file ${body}`, { env, cwd: client }));
  assertDenied(claudeHook(`gh issue -R octo-owner/project comment 1 --body-file ${body}`, { env, cwd: client }));
  assertDenied(claudeHook(`GH_REPO=octo-owner/project gh issue create --title t --body-file ${body}`, { env, cwd: client }));
  assertDenied(claudeHook(`gh issue create --title t --body-file ${body}`, { env: { ...env, GH_REPO: 'octo-owner/project' }, cwd: client }));
  assertDenied(claudeHook('gh repo edit octo-owner/project --description "acme-internal mirror"', { env, cwd: client }));
  assertDenied(claudeHook('gh repo rename acme-internal', { env, cwd: dir }));
  writeFileSync(join(dir, 'staged.md'), 'AcmeWidget\n');
  git(dir, env, 'add', 'staged.md');
  mkdirSync(join(dir, 'sub'));
  assertDenied(claudeHook('cd "$(git rev-parse --show-toplevel)" && git commit -m ok', { env, cwd: join(dir, 'sub') }), /staged staged\.md/);
  assertDenied(claudeHook(`REPO=${dir}; cd "$REPO" && git commit -m ok`, { env, cwd: client }), /staged staged\.md/);
  assertDenied(claudeHook('LANG="C" git commit -m ok', { env, cwd: dir }), /staged staged\.md/);
  assertSilent(claudeHook(`GH_REPO=client-owner/app gh issue create --title "acme-internal" --body x`, { env, cwd: dir }));
});

test('gh api: base64 payloads are decoded, GraphQL reads pass, issue templates are names', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const content = Buffer.from('internal notes for acme-internal\n').toString('base64');
  assertDenied(claudeHook(`gh api -X PUT repos/octo-owner/project/contents/notes.md -f message=add -f content=${content}`, { env, cwd: env.HOME }), /base64-decoded/);
  assertSilent(claudeHook(`gh api graphql -f query='{ repository(owner:"acme-internal", name:"x") { id } }'`, { env, cwd: env.HOME }));
  assertDenied(claudeHook(`gh api graphql -f query='mutation { addStar(input:{starrableId:"acme-internal"}) { clientMutationId } }'`, { env, cwd: env.HOME }));
  assertSilent(claudeHook('gh issue create --template "Bug report" --title x --body y', { env, cwd: dir }));
});

test('commands run through the Monitor tool are checked like Bash', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const toolInput = { command: 'gh pr comment 1 --body acme-internal', description: 'x', timeout_ms: 1000 };
  assertDenied(claudeHook(null, { env, cwd: dir, tool: 'Monitor', toolInput }));
  assertSilent(claudeHook(null, { env, cwd: dir, tool: 'Monitor', toolInput: { command: 'tail -f log', description: 'x', timeout_ms: 1000 } }));
});

test('git push: .gitattributes cannot hide content, and push.followTags tags are checked', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, '.gitattributes', '*.lock binary\n', 'attrs');
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit(dir, env, 'deps.lock', 'registry acme-internal\n', 'deps');
  assertDenied(claudeHook('git push origin main', { env, cwd: dir }), /deps\.lock, line 1/);
  git(dir, env, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, env, 'tag', '-a', 'v1', '-m', 'Release for AcmeWidget');
  assertSilent(claudeHook('git push origin main', { env, cwd: dir }));
  git(dir, env, 'config', 'push.followTags', 'true');
  assertDenied(claudeHook('git push origin main', { env, cwd: dir }), /tag v1 message/);
  assertSilent(claudeHook('git push --no-follow-tags origin main', { env, cwd: dir }));
});

test('a check that would outlast the hook timeout is denied, not let through', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  commit(dir, env, 'a.txt', 'one\n', 'Initial');
  const slow = { ...env, PUBLISH_GUARD_HOOK_BUDGET_MS: '1' };
  assertDenied(claudeHook('git push origin main', { env: slow, cwd: dir }), /took longer/);
  assertSilent(claudeHook('ls', { env: slow, cwd: dir }));
});
