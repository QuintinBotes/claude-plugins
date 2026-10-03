# Adding a plugin

## A plugin with its own repository

Use this when the plugin has a runtime, tests, CI or releases of its own.

1. Make sure the repository has `.claude-plugin/plugin.json` at the plugin
   root, and that its `name` is the name you want people to install by.
2. Add an entry to `.claude-plugin/marketplace.json`:

   ```json
   {
     "name": "my-plugin",
     "source": { "source": "github", "repo": "QuintinBotes/my-plugin" },
     "description": "One sentence on what it does.",
     "category": "development",
     "tags": ["..."],
     "homepage": "https://github.com/QuintinBotes/my-plugin",
     "repository": "https://github.com/QuintinBotes/my-plugin",
     "license": "MIT"
   }
   ```

   If the plugin sits in a subdirectory of its repository, use
   `{ "source": "git-subdir", "url": "QuintinBotes/repo", "path": "plugins/my-plugin" }`.

3. Leave `version` out of the entry. The plugin's own `plugin.json` wins at
   install time, and two copies drift.

The repository has to be public before the entry is useful to anyone else. A
private repository installs only for people with read access to it.

## A plugin that lives here

Use this for skills and small plugins with no build step.

1. Create `plugins/my-plugin/` with `.claude-plugin/plugin.json` and its
   components (`skills/`, `agents/`, `hooks/`, `commands/`).
2. Run `claude plugin validate ./plugins/my-plugin`.
3. Add an entry with `"source": "./plugins/my-plugin"`.

## Before opening a pull request

```bash
node scripts/validate-catalog.mjs
claude plugin validate --strict .
```

To try the catalog without touching your own Claude Code settings, point
`CLAUDE_CONFIG_DIR` at an empty directory:

```bash
export CLAUDE_CONFIG_DIR="$(mktemp -d)"
claude plugin marketplace add ./
claude plugin install my-plugin@quintinbotes
claude plugin details my-plugin
```

## Renaming or removing a plugin

Add the old name to `renames` in `marketplace.json` (or map it to `null` for a
removal) so existing installs follow the change instead of breaking.
