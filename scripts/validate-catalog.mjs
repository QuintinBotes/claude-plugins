#!/usr/bin/env node
// Checks that every entry in .claude-plugin/marketplace.json resolves to a
// plugin whose manifest name matches the entry name. `claude plugin validate`
// only reads files inside the marketplace, so a wrong repo, path or name in a
// remote source would otherwise surface only when someone tries to install.
//
// Usage: node scripts/validate-catalog.mjs
// Set GITHUB_TOKEN to raise the API rate limit or to reach private repos.

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const errors = [];
const warnings = [];

const catalog = JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8'));

if (!NAME.test(catalog.name ?? '') || catalog.name.includes('..')) {
  errors.push(`marketplace name ${JSON.stringify(catalog.name)} is not a valid plugin-id segment`);
}
if (!catalog.owner?.name) errors.push('owner.name is required');
if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
  errors.push('plugins must be a non-empty array');
}

const seen = new Set();
for (const [i, entry] of (catalog.plugins ?? []).entries()) {
  const label = `plugins[${i}] ${entry.name ?? '(unnamed)'}`;
  if (!NAME.test(entry.name ?? '')) {
    errors.push(`${label}: name is not a valid plugin-id segment`);
    continue;
  }
  if (seen.has(entry.name)) errors.push(`${label}: duplicate plugin name`);
  seen.add(entry.name);
  if (!entry.description) warnings.push(`${label}: no description; /plugin listings will be blank`);

  try {
    const manifest = await loadManifest(entry.source);
    if (manifest === null) continue;
    if (manifest.name !== entry.name) {
      errors.push(`${label}: plugin.json name is ${JSON.stringify(manifest.name)}; install by entry name would fail`);
    } else {
      console.log(`ok  ${entry.name}@${catalog.name}  ${describe(entry.source)}  v${manifest.version ?? '?'}`);
    }
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
  }
}

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
if (errors.length) process.exit(1);
console.log(`\n${seen.size} plugin(s) resolve.`);

async function loadManifest(source) {
  if (typeof source === 'string') return loadLocal(source);
  switch (source?.source) {
    case 'github':
      return fetchGitHub(source.repo, '.claude-plugin/plugin.json', source.sha ?? source.ref);
    case 'git-subdir': {
      const repo = githubRepo(source.url);
      if (!repo) {
        warnings.push(`git-subdir ${source.url} is not on GitHub; skipped remote check`);
        return null;
      }
      return fetchGitHub(repo, `${source.path.replace(/\/$/, '')}/.claude-plugin/plugin.json`, source.sha ?? source.ref);
    }
    default:
      warnings.push(`source type ${JSON.stringify(source?.source)} is not checked by this script`);
      return null;
  }
}

async function loadLocal(path) {
  if (!path.startsWith('./') || path.split('/').includes('..')) {
    throw new Error(`relative source must start with ./ and stay inside the repo: ${path}`);
  }
  const dir = join(root, path);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error(`source path does not exist: ${path}`);
  const text = await readFile(join(dir, '.claude-plugin/plugin.json'), 'utf8').catch(() => null);
  if (text === null) throw new Error(`${path} has no .claude-plugin/plugin.json`);
  return JSON.parse(text);
}

function githubRepo(url) {
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return url;
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function fetchGitHub(repo, path, ref) {
  const url = new URL(`https://api.github.com/repos/${repo}/contents/${path}`);
  if (ref) url.searchParams.set('ref', ref);
  const headers = { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'quintinbotes-catalog-validator' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) throw new Error(`${repo}/${path}${ref ? `@${ref}` : ''} not found`);
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${repo}/${path}`);
  return JSON.parse(await res.text());
}

function describe(source) {
  if (typeof source === 'string') return source;
  const at = source.sha ?? source.ref;
  const where = source.source === 'git-subdir' ? `${source.url}//${source.path}` : source.repo ?? source.url;
  return `${source.source}:${where}${at ? `@${at}` : ''}`;
}
