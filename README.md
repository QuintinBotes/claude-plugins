# Claude Code plugins by Quintin Botes

One marketplace for every Claude Code plugin I build. Add it once and install
any of them by name.

```bash
claude plugin marketplace add QuintinBotes/claude-plugins
claude plugin install review-voice@quintinbotes
```

Inside a session, `/plugin marketplace add QuintinBotes/claude-plugins` does the
same, and `/plugin` lets you browse the catalog.

## Plugins

| Plugin | What it does | Source |
|---|---|---|
| [review-voice](https://github.com/QuintinBotes/review-voice) | A concise, precedent-aware code reviewer. Every finding names a concrete failure mode in 40 words or fewer, ordered worst-first, evidence required, silence when nothing qualifies. | `QuintinBotes/review-voice`, `plugins/review-voice` |
| [circuit-breaker](https://github.com/QuintinBotes/circuit-breaker) | Investigation, mutation, refutation and verification as states a hook enforces, rather than instructions a model is asked to follow. | `QuintinBotes/circuit-breaker` |
| [orbit](https://github.com/QuintinBotes/orbit) | An autonomous, evidence-driven engineering loop for Claude Code: contracts, isolated workers, independent verification, and recoverable unattended runs. | `QuintinBotes/orbit` (`plugin/`) |
| [swarm](https://github.com/QuintinBotes/swarm) | Parallel agent orchestration: author a spec, decompose it into exclusive-ownership tasks, run them across isolated git worktrees, gate the merge on QA and review. | `QuintinBotes/swarm` |
| [unknot](https://github.com/QuintinBotes/unknot) | Architecture-aware, incremental simplification: maps code, data and infrastructure, finds accidental complexity, picks decomposition patterns from measured evidence, and changes code only in small approved slices that a deterministic kernel verifies and can roll back. | `QuintinBotes/unknot` |
| [publish-guard](plugins/publish-guard) | Keeps private terms and work emails out of commits, pushes, pull requests, issues and releases in repositories you own, with one scanner running as a Claude Code hook, as git hooks and in CI. | `plugins/publish-guard` |

## How the catalog is laid out

Plugins that ship a runtime, a test suite and their own release process keep
their own repository. The catalog references them by GitHub source, so their
issues, CI and history stay where they are, and installing from their own
marketplace keeps working.

Smaller plugins and standalone skills live in this repository under
[`plugins/`](plugins/). See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add
either kind.

Entries track each repository's default branch, so
`claude plugin marketplace update quintinbotes` picks up whatever has been
released there.

## Checks

`node scripts/validate-catalog.mjs` fetches every entry's `plugin.json` and
fails if the name in it differs from the entry name, which is the mistake that
makes `claude plugin install` fail for users. CI runs it on every change and
weekly, together with `claude plugin validate --strict` and the tests of the
plugins in [`plugins/`](plugins/).

## License

MIT. Each plugin carries its own license in its repository.
