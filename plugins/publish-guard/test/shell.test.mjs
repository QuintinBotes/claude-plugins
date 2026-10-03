import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShell } from '../lib/shell.mjs';

const words = (src) => parseShell(src).commands.map((c) => c.words.map((w) => w.value));

test('lists, pipelines, quotes and escapes', () => {
  assert.deepEqual(words(`cd "/tmp/a b" && git commit -m 'it'"'"'s done' ; echo \\$HOME | cat`), [
    ['cd', '/tmp/a b'],
    ['git', 'commit', '-m', "it's done"],
    ['echo', '$HOME'],
    ['cat'],
  ]);
});

test('Claude Code style heredoc inside $(...) evaluates to its body', () => {
  const src = `git commit -m "$(cat <<'EOF'
Fix the thing (don't panic)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push`;
  const cmds = words(src);
  assert.deepEqual(cmds[0], ['git', 'commit', '-m', "Fix the thing (don't panic)\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
  assert.deepEqual(cmds[1], ['git', 'push']);
});

test('heredoc as stdin and here-strings', () => {
  const { commands } = parseShell(`gh pr create --title t --body-file - <<EOF\nline one\n  line two\nEOF\necho done`);
  assert.equal(commands[0].stdin, 'line one\n  line two\n');
  assert.deepEqual(commands[1].words.map((w) => w.value), ['echo', 'done']);
  assert.equal(parseShell(`cat <<< "hi there"`).commands[0].stdin, 'hi there\n');
  assert.equal(parseShell('cat <<-X\n\tindented\n\tX\n').commands[0].stdin, 'indented\n');
});

test('assignments, redirects and pipes are separated from words', () => {
  const [c, d] = parseShell('GIT_AUTHOR_EMAIL=a@b.example git commit -m x 2>&1 > out.txt | tee log').commands;
  assert.deepEqual(c.assigns, [{ name: 'GIT_AUTHOR_EMAIL', value: 'a@b.example' }]);
  assert.deepEqual(c.words.map((w) => w.value), ['git', 'commit', '-m', 'x']);
  assert.deepEqual(c.redirs.map((r) => [r.op, r.target]), [['>&', '1'], ['>', 'out.txt']]);
  assert.equal(d.pipeFrom, c);
});

test('ANSI-C quoting and nested substitutions', () => {
  assert.deepEqual(words(`printf $'a\\tb\\x41'`), [['printf', 'a\tbA']]);
  const { substitutions } = parseShell('echo "$(git log -1 --format=%s $(git rev-parse HEAD))"');
  assert.equal(substitutions.length, 2);
});

test('comments and subshells', () => {
  assert.deepEqual(words('# just a comment\n(cd x && git push) # trailing'), [['cd', 'x'], ['git', 'push']]);
});

test('assignments with quoted values stay assignments', () => {
  const [cmd] = parseShell(`GIT_AUTHOR_NAME="A B" LANG='C' git commit -m x`).commands;
  assert.deepEqual(
    cmd.assigns.map((a) => [a.name, a.value]),
    [
      ['GIT_AUTHOR_NAME', 'A B'],
      ['LANG', 'C'],
    ],
  );
  assert.deepEqual(
    cmd.words.map((w) => w.value),
    ['git', 'commit', '-m', 'x'],
  );
});
