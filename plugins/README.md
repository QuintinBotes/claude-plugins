# In-repo plugins

Plugins and skills small enough not to need their own repository live here, one
directory per plugin. Each one needs `.claude-plugin/plugin.json` and an entry in
`../.claude-plugin/marketplace.json` with a `./plugins/<name>` source. Tests in
`<name>/test/*.test.mjs` run in CI with `node --test`.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
