import assert from 'node:assert/strict';
import test from 'node:test';
import { isProtectedOwner, loadConfig } from '../lib/config.mjs';
import * as G from '../lib/git.mjs';
import { parseGhRepoArg, parseGitHubUrl } from '../lib/github.mjs';
import { git, makeRepo, setup } from './helpers.mjs';

const env = { PUBLISH_GUARD_NO_SSH_LOOKUP: '1' };

test('GitHub URL forms resolve to the same owner', () => {
  const forms = [
    'https://github.com/Octo-Owner/project.git',
    'https://github.com/octo-owner/project',
    'https://user:token@github.com/octo-owner/project.git/',
    'http://github.com/octo-owner/project',
    'git@github.com:octo-owner/project.git',
    'github.com:octo-owner/project',
    'ssh://git@github.com/octo-owner/project.git',
    'ssh://git@ssh.github.com:443/octo-owner/project.git',
    'git://github.com/octo-owner/project.git',
    'git@github.com-personal:octo-owner/project.git',
  ];
  for (const url of forms) {
    const r = parseGitHubUrl(url, env);
    assert.ok(r, url);
    assert.equal(r.owner.toLowerCase(), 'octo-owner', url);
    assert.equal(r.repo, 'project', url);
  }
});

test('non-GitHub remotes have no owner', () => {
  for (const url of ['/srv/git/project.git', 'file:///srv/git/project.git', 'https://gitlab.com/octo-owner/project.git', '../sibling', 'C:/repos/x']) {
    assert.equal(parseGitHubUrl(url, env), null, url);
  }
});

test('gh --repo forms', () => {
  assert.equal(parseGhRepoArg('octo-owner/project', env).owner, 'octo-owner');
  assert.equal(parseGhRepoArg('github.com/octo-owner/project', env).owner, 'octo-owner');
  assert.equal(parseGhRepoArg('https://github.com/octo-owner/project', env).owner, 'octo-owner');
  assert.equal(parseGhRepoArg('ghe.example.com/octo-owner/project', env), null);
});

test('protected owners compare case-insensitively', () => {
  const { env: e } = setup({ owners: ['Octo-Owner'] });
  const config = loadConfig({ env: e });
  assert.ok(isProtectedOwner(config, 'octo-owner'));
  assert.ok(!isProtectedOwner(config, 'client-owner'));
});

test('repository protection follows its remotes, including insteadOf rewrites', () => {
  const { env: e } = setup();
  const config = loadConfig({ env: e });
  const genv = G.gitEnv(e);
  const prot = makeRepo(e, { remote: 'git@github.com:octo-owner/project.git' });
  assert.ok(G.repoIsProtected(G.repoInfo(prot, { env: genv }), config, genv));

  const other = makeRepo(e, { remote: 'https://github.com/client-owner/app.git' });
  assert.ok(!G.repoIsProtected(G.repoInfo(other, { env: genv }), config, genv));

  // A second remote pointing at a protected owner makes the repo protected.
  git(other, e, 'remote', 'add', 'mine', 'https://github.com/octo-owner/app.git');
  assert.ok(G.repoIsProtected(G.repoInfo(other, { env: genv }), config, genv));

  const rewritten = makeRepo(e, { remote: 'mine:project.git' });
  git(rewritten, e, 'config', 'url.git@github.com:octo-owner/.insteadOf', 'mine:');
  assert.ok(G.repoIsProtected(G.repoInfo(rewritten, { env: genv }), config, genv));

  const local = makeRepo(e, { remote: null });
  assert.ok(!G.repoIsProtected(G.repoInfo(local, { env: genv }), config, genv));
  git(local, e, 'config', 'publish-guard.protect', 'true');
  assert.ok(G.repoIsProtected(G.repoInfo(local, { env: genv }), config, genv));
});
