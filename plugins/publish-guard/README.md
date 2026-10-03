# publish-guard

Keeps private terms (an employer's or a client's name, internal project and
repository names) and work email addresses out of what you publish to the
GitHub repositories you own.

Leaks of this kind rarely come from code. They come from the text around it:
a pull request description, an issue body, a squash-merge commit message, a
CHANGELOG entry, or the author email in commit metadata, including merges made
on github.com, which use the account's default commit email. Once that text is
on a public repository it is in forks, mirrors and caches, and rewriting
history does not reach them.

publish-guard checks all of those, at three layers, with one scanner.

## What it checks

- **Private terms.** A list you keep outside every repository
  (`~/.config/publish-guard/terms.txt`). One term per line, matched
  case-insensitively as a substring; lines starting with `re:` are regular
  expressions. Text is also matched as a reader sees it: a term wrapped onto
  the next line, written with a Unicode dash, or split by a zero-width
  character still counts.
- **Email identities.** Every author, committer and tagger address, and every
  address in a trailer such as `Co-authored-by:` or `Signed-off-by:`, must be in
  `allowed_emails` or match `allowed_email_patterns`. Addresses in file content
  and free text are flagged only when they look like a real mailbox and are not
  allowed, so `you@example.com`, `git@github.com:...` and `icon@2x.png` stay
  quiet.
- **Only for protected owners.** Enforcement applies when the target
  repository's GitHub owner is in `protected_owners`. Every other repository
  passes untouched, so client repositories, where the terms are legitimate, keep
  working.

Reports never contain a matched term. A finding names the terms file line and
shows an excerpt with the match blacked out, because CI logs on public
repositories are public too:

```
commit 3f1c2a9b04 message, line 1: private term #2 (terms.txt line 4): Merge ███ work
commit 3f1c2a9b04 author: email d***@corp-mail.io is not an allowed commit identity
```

## Three layers

| Layer | Runs | Catches |
|---|---|---|
| Claude Code hook | `PreToolUse` on Bash, Monitor and GitHub MCP tools | `git commit` (message, staged changes, effective author), `git push` (every outgoing commit), `gh pr`/`issue`/`release`/`gist`/`repo`/`label` writes, `gh api` writes, GitHub MCP writes. The call is denied with a reason Claude can act on. |
| Git hooks | `pre-commit`, `commit-msg`, `pre-push` | Commits and pushes made outside Claude Code: by hand, by an IDE, by scripts. |
| CI | Reusable GitHub Actions workflow | Pushes, pull requests (commits, title, body), issues, comments and reviews, including edits made on github.com. |

### Claude Code hook details

- A Bash call that does not mention `git` or `gh` exits immediately; the rest
  are parsed (quotes, heredocs, `$(cat <<'EOF' ... EOF)`, pipelines, `cd`,
  `env`, `bash -c`, `eval`, git aliases) to find the publishing commands and
  the repository each one targets.
- For a protected repository the whole command string is scanned as well,
  since heredoc bodies live there, together with every file passed through
  `--body-file`, `-F`, `--notes-file`, `--input`, `-F field=@file`, gist files
  and release assets, files read through `$(cat FILE)` or `$(< FILE)`, and
  base64 payloads of `gh api` (the contents API takes file content that way).
  A file the same command fills from another program, or text piped in from
  one, is denied rather than guessed at.
- The target repository is found the way gh and git find it: `cd`, `git -C`,
  `gh -R` (also before the subcommand, `gh pr --repo OWNER/REPO create`),
  `GH_REPO`, `gh repo edit OWNER/REPO`, and `cd "$(git rev-parse
  --show-toplevel)"`.
- `git push` scans every commit reachable from what is pushed that the target
  remote's tracking refs do not already have. A first push to a new remote
  therefore scans the whole history, which is exactly what it publishes.
  `.gitattributes` entries such as `binary` or `-diff` do not hide a file's
  lines from the scan, and `push.followTags` tags are checked.
- `gh pr merge --squash` or `--merge` needs `--author-email` with an allowed
  address; without it GitHub authors the merge commit with the account's
  default email. Set `"require_merge_author_email": false` in the config to turn
  this off.
- It fails closed: if the config exists but cannot be used, the terms file
  cannot be read, or the scanner breaks while checking a publishing command,
  the command is denied with the reason. With no config at all nothing is
  protected, and the hook says so when a publishing command runs.
  Non-publishing commands are never blocked. The hook never answers "allow",
  so your permission settings still decide everything it lets through.
- Claude Code runs a command whose hook timed out, so a check that would run
  past 90 seconds (a first push of a very large history) is stopped and the
  command denied. Push from a terminal instead, where the git hooks have no
  time limit.

## Setup

Requires Node.js 20 or later on `PATH`.

1. Install the plugin:

   ```bash
   claude plugin marketplace add QuintinBotes/claude-plugins
   claude plugin install publish-guard@quintinbotes
   ```

   Inside Claude Code the `publish-guard` command is on the Bash tool's `PATH`.
   For your own shell, link the copy in the marketplace checkout, which
   `claude plugin marketplace update` keeps current:

   ```bash
   ln -s ~/.claude/plugins/marketplaces/quintinbotes/plugins/publish-guard/bin/publish-guard ~/.local/bin/publish-guard
   ```

2. Create the config and terms templates (mode 0600; existing files are never
   overwritten):

   ```bash
   publish-guard init --owner your-github-user --email you@personal.example
   ```

   `~/.config/publish-guard/config.json` (or `$PUBLISH_GUARD_CONFIG`):

   ```json
   {
     "protected_owners": ["your-github-user"],
     "allowed_emails": ["you@personal.example"],
     "allowed_email_patterns": ["@users\\.noreply\\.github\\.com$", "^noreply@github\\.com$", "^support@github\\.com$", "@example\\.(com|org|net)$", "^noreply@anthropic\\.com$"],
     "terms_file": "~/.config/publish-guard/terms.txt"
   }
   ```

3. Edit the terms file. Prefer specific terms over generic words, which cause
   false positives:

   ```
   acme-internal
   AcmeWidget
   re:acme[ ._-]?corp
   ```

4. Install the git hooks in each repository you publish from:

   ```bash
   publish-guard install-git-hooks ~/code/my-repo
   ```

   An existing hook is kept as `<name>.local` and runs after the guard. If
   `core.hooksPath` is set (husky and similar tools), nothing is installed and
   the lines to add to those hooks are printed instead. Re-run the command after
   the plugin moves; a hook whose guard is missing refuses to continue.

5. Add the CI layer to each protected repository,
   `.github/workflows/publish-guard.yml`:

   ```yaml
   name: Publish guard
   on:
     pull_request:
       types: [opened, synchronize, reopened, edited]
     push:
       branches: [main]
     issues:
       types: [opened, edited]
     issue_comment:
       types: [created, edited]
     pull_request_review:
       types: [submitted, edited]
     pull_request_review_comment:
       types: [created, edited]
   permissions: {}
   jobs:
     guard:
       permissions:
         contents: read
       uses: QuintinBotes/claude-plugins/.github/workflows/publish-guard.yml@<commit-sha>
       with:
         allowed-emails: you@personal.example
         allowed-email-patterns: '^noreply@anthropic\.com$'
       secrets:
         PUBLISH_GUARD_TERMS: ${{ secrets.PUBLISH_GUARD_TERMS }}
   ```

   and give it the terms as a secret:

   ```bash
   gh secret set PUBLISH_GUARD_TERMS < ~/.config/publish-guard/terms.txt
   ```

   The workflow runs the scanner from the same commit you pinned. Fork pull
   requests never receive secrets, so those runs check email identities only and
   say so in the log. Titles, bodies and comments written by people without
   write access are never checked against the terms, because a pass or fail on
   their own comment would let anyone probe the list one guess at a time.

6. On github.com, open **Settings > Emails** and set the email used for
   web-based Git operations (merges, squashes and edits made in the browser) to
   your personal address or your `users.noreply.github.com` address. The work
   address in a web merge cannot be stopped from your machine; this setting is
   what stops it.

## Commands

```
publish-guard scan --text-file FILE | --stdin    scan text
publish-guard scan --git-staged                  staged changes and the commit identity
publish-guard scan --git-range A..B              messages, identities and added lines in a range
publish-guard scan --commit-msg-file FILE        a commit message, comment lines stripped
publish-guard audit [DIR] [--no-worktree] [--all]
publish-guard hook claude                        the Claude Code hook (JSON on stdin)
publish-guard hook git pre-commit|commit-msg|pre-push
publish-guard install-git-hooks [REPO]
publish-guard init [--owner NAME] [--email ADDRESS]
publish-guard ci [DIR]                           used by the reusable workflow
```

`scan` and `audit` take `--json`. Exit status is 0 when clean, 1 for findings,
2 for usage or configuration errors.

`audit` walks every ref (branches, tags, pull request refs in a mirror, notes,
stash): every commit message and identity, every annotated tag, every version
of every file and every path name, plus uncommitted work in the working tree. It
prints one summary line per commit, tag, file or path, then the details. Run it
on a `git clone --mirror` of a repository to see what has already leaked before
cleaning it up.

A repository with no GitHub remote yet is not protected. To protect it anyway:

```bash
git config publish-guard.protect true
```

## Limitations

- Text the hook cannot see is not checked by it: commands run inside a script
  file, `gh` aliases, `curl` calls to the GitHub API, shell variables it cannot
  resolve, and command substitutions other than `cat` (`--body "$(./notes)"`).
  A body piped from a program is denied instead. The git hooks and CI cover
  most of what remains.
- A GraphQL mutation names its target by node ID, so `gh api graphql` resolves
  the owner from the current repository; GraphQL queries are reads and pass.
- GitHub MCP tools cannot set the author email of a merge; the account setting
  in step 6 covers that.
- Terms are matched as text. A different spelling (`acmeinternal`,
  `acme internal`) defeats the check unless it is listed too. Add variants as
  extra terms or a `re:` line.
- The CI layer reports after the fact for issues and comments; it cannot stop
  them from being posted, only make the leak visible so you can edit it.

## Development

```bash
node --test plugins/publish-guard/test/*.test.mjs
claude plugin validate --strict plugins/publish-guard
```

Tests use temporary config and terms files through `PUBLISH_GUARD_CONFIG`, a
git environment that ignores your own git config, and repositories whose
GitHub remotes are never contacted. Use placeholder terms such as
`acme-internal` in tests and docs; real terms never belong in a repository.
