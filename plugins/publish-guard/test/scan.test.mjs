import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { BLOCK, excerpt, formatFinding, makeEmailPolicy, parseTerms, redact, Scanner } from '../lib/scan.mjs';
import { commit, containsTerm, git, makeRepo, ME, run, setup, TERMS, WORK } from './helpers.mjs';

const terms = parseTerms(TERMS);
const scanner = new Scanner({
  terms,
  emailPolicy: makeEmailPolicy({ allowedEmails: [ME], allowedEmailPatterns: [/@users\.noreply\.github\.com$/i, /^noreply@anthropic\.com$/i, /@example\.(com|org|net)$/i] }),
});

test('terms file: comments and blanks skipped, line numbers kept', () => {
  assert.deepEqual(
    terms.map((t) => [t.ordinal, t.line]),
    [
      [1, 3],
      [2, 4],
      [3, 5],
    ],
  );
});

test('substring terms match case-insensitively anywhere', () => {
  const f = scanner.text('see ACME-INTERNAL/docs and xAcmeWidgetx', 'text');
  assert.deepEqual(
    f.map((x) => x.ordinal),
    [1, 2],
  );
  assert.equal(f[0].termLine, 3);
});

test('regex terms match with re: prefix', () => {
  for (const s of ['the Acme Corp team', 'acme.corp', 'ACME_CORP']) {
    const f = scanner.text(s, 'text');
    assert.equal(f.length, 1, s);
    assert.equal(f[0].ordinal, 3);
    assert.equal(f[0].termLine, 5);
  }
  assert.equal(scanner.text('acmecorp and acme-corporate', 'text').length, 0);
});

test('invalid regex term is reported by line without echoing the pattern', () => {
  assert.throws(() => parseTerms('ok\nre:acme(\n', 'terms.txt'), (err) => err.message === 'terms.txt line 2: invalid regular expression');
});

test('excerpts and reports never contain the matched term', () => {
  const line = 'Deploying AcmeWidget for the acme-internal and Acme Corp teams';
  const f = scanner.text(line, 'commit 1234 message');
  assert.equal(f.length, 3);
  for (const finding of f) {
    const out = formatFinding(finding, scanner);
    assert.ok(!containsTerm(out), out);
    assert.match(out, /private term #\d \(terms\.txt line \d\)/);
    assert.ok(out.includes(BLOCK));
  }
  assert.equal(redact(line, terms), `Deploying ${BLOCK} for the ${BLOCK} and ${BLOCK} teams`);
});

test('excerpt cut cannot expose a match created by trimming', () => {
  // A word-boundary regex that does not match inside a longer word must
  // still be redacted if cutting the excerpt puts a boundary before it.
  const t = parseTerms('re:\\bcorpx\\b');
  const line = `${'y'.repeat(60)}zcorpx tail`;
  const out = excerpt(line, 60, t);
  assert.ok(!/(^|\W)corpx\b/i.test(out.replace(BLOCK, '')), out);
});

test('a term wrapped across lines, written with a Unicode dash or split by an invisible character still matches', () => {
  const nbHyphen = String.fromCharCode(0x2011);
  const zeroWidth = String.fromCharCode(0x200b);
  const fragment = /acme|corp|internal|widget/i;
  for (const s of ['the acme\ncorp exporter', 'acme-\n  internal tools', `acme${nbHyphen}internal`, `Acme${zeroWidth}Widget`, 'acme  \r\n corp']) {
    const f = scanner.text(s, 'text');
    assert.equal(f.length, 1, JSON.stringify(s));
    assert.ok(!fragment.test(f[0].excerpt), f[0].excerpt);
    assert.ok(!fragment.test(redact(s, terms)), redact(s, terms));
  }
  // A later finding on the second line hides the part of the wrapped match
  // that continues there.
  const two = scanner.text('see acme\ncorp and AcmeWidget', 'text');
  assert.deepEqual(
    two.map((f) => [f.ordinal, f.line]),
    [
      [3, 1],
      [2, 2],
    ],
  );
  for (const f of two) assert.ok(!fragment.test(f.excerpt), f.excerpt);
});

test('identity emails must be allowed (strict rule)', () => {
  assert.equal(scanner.identity('Me', ME, 'author').length, 0);
  assert.equal(scanner.identity('Bot', '123+bot@users.noreply.github.com', 'author').length, 0);
  const f = scanner.identity('Me', WORK, 'author');
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'email');
  assert.equal(f[0].rule, 'identity');
  assert.equal(f[0].email, 'd***@corp-mail.io');
});

test('Co-authored-by trailers use the strict rule', () => {
  const ok = scanner.message('Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n', 'message');
  assert.equal(ok.length, 0);
  const bad = scanner.message(`Fix\n\nCo-authored-by: Someone <${WORK}>\nSigned-off-by: X <x@localhost>\n`, 'message');
  assert.deepEqual(
    bad.map((f) => [f.rule, f.line]),
    [
      ['trailer', 3],
      ['trailer', 4],
    ],
  );
});

test('content emails: only real-looking, non-allowed addresses', () => {
  const quiet = [
    'mail you@example.com',
    'clone git@github.com:octo-owner/x.git',
    'https://token@github.com/octo-owner/x',
    'icon@2x.png',
    'actions/checkout@v4',
    'npm i react@18.2.0',
    'root@localhost',
    'noreply@corp-mail.io',
    `ping ${ME}`,
  ];
  for (const s of quiet) assert.equal(scanner.text(s, 'diff').length, 0, s);
  const f = scanner.text(`contact ${WORK} for access`, 'diff');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'content');
});

test('CLI scan prints no term and exits 1 on findings', () => {
  const { env, home } = setup();
  const file = join(home, 'body.md');
  writeFileSync(file, 'Release notes\nBuilt for AcmeWidget by the acme-internal crew.\n');
  const res = run(['scan', '--text-file', file], { env });
  assert.equal(res.code, 1);
  assert.ok(!containsTerm(res.stdout + res.stderr), res.stdout);
  assert.match(res.stdout, /line 2: private term #2 \(terms\.txt line 4\)/);

  const json = run(['scan', '--stdin', '--json'], { env, input: 'nothing private here\n' });
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { findings: [] });
});

test('CLI exits 2 with a clear message when the terms file is missing', () => {
  const { env, termsFile } = setup();
  writeFileSync(termsFile, '');
  const ok = run(['scan', '--stdin'], { env, input: 'x' });
  assert.equal(ok.code, 0);
  const res = run(['scan', '--stdin'], { env: { ...env, PUBLISH_GUARD_CONFIG: join(env.HOME, 'nope.json') }, input: 'x' });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no config/);
});

test('CLI scan of staged changes, ranges and commit message files', () => {
  const { env } = setup();
  const dir = makeRepo(env);
  const base = commit(dir, env, 'a.txt', 'one\n', 'Initial');
  commit(dir, env, 'b.txt', 'two\n', 'Mention AcmeWidget');
  writeFileSync(join(dir, 'c.txt'), 'acme-internal\n');
  git(dir, env, 'add', 'c.txt');

  const staged = run(['scan', '--git-staged'], { env, cwd: dir });
  assert.equal(staged.code, 1);
  assert.match(staged.stdout, /staged c\.txt, line 1: private term #1/);

  const range = run(['scan', '--git-range', `${base}..HEAD`, '--json'], { env, cwd: dir });
  assert.equal(range.code, 1);
  const { findings } = JSON.parse(range.stdout);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].term, { ordinal: 2, line: 4 });
  assert.ok(!containsTerm(range.stdout));

  const msg = join(dir, 'MSG');
  writeFileSync(msg, 'Clean subject\n\n# Please enter the commit message; acme-internal is in a comment\n');
  assert.equal(run(['scan', '--commit-msg-file', msg], { env, cwd: dir }).code, 0);
  writeFileSync(msg, `Subject\n\nCo-authored-by: Someone <${WORK}>\n`);
  const trailer = run(['scan', '--commit-msg-file', msg], { env, cwd: dir });
  assert.equal(trailer.code, 1);
  assert.match(trailer.stdout, /in a trailer is not allowed/);
});
