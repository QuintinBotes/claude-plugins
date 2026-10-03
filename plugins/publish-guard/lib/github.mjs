// Works out which GitHub owner a remote URL or a gh repository argument
// points at. Enforcement keys off the owner, so every URL form git and gh
// accept has to resolve the same way.

import { spawnSync } from 'node:child_process';

const sshHostCache = new Map();

function looksLikeGitHubHost(host) {
  return /github/i.test(host);
}

// SSH host aliases (`git@work:owner/repo.git` with `Host work` mapping to
// github.com in ~/.ssh/config) are common for people with two GitHub
// accounts. `ssh -G` prints the resolved config without connecting.
function sshResolvesToGitHub(host, env) {
  if (sshHostCache.has(host)) return sshHostCache.get(host);
  let result = false;
  if (/^[A-Za-z0-9._-]+$/.test(host) && env?.PUBLISH_GUARD_NO_SSH_LOOKUP !== '1') {
    const res = spawnSync('ssh', ['-G', host], { encoding: 'utf8', timeout: 2000 });
    if (res.status === 0) {
      const m = /^hostname\s+(\S+)/m.exec(res.stdout);
      result = Boolean(m && /^(ssh\.)?github\.com$/i.test(m[1]));
    }
  }
  sshHostCache.set(host, result);
  return result;
}

function splitPath(path) {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

// Returns { host, owner, repo } for a GitHub remote, or null when the URL is
// not on GitHub (local paths, file:// remotes, other hosts).
export function parseGitHubUrl(url, env = process.env) {
  if (!url || typeof url !== 'string') return null;
  url = url.trim();
  let host;
  let path;
  let ssh = false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(proto)) return null;
    const rest = scheme[2];
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    host = rest.slice(0, slash).replace(/^.*@/, '').replace(/:\d+$/, '');
    path = rest.slice(slash);
    ssh = proto.includes('ssh');
  } else {
    // scp-like: [user@]host:owner/repo(.git)
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
    if (!m) return null;
    host = m[1];
    path = m[2];
    ssh = true;
  }
  if (!looksLikeGitHubHost(host) && !(ssh && sshResolvesToGitHub(host, env))) return null;
  const parsed = splitPath(path);
  return parsed ? { host: host.toLowerCase(), ...parsed } : null;
}

// gh's -R/--repo accepts OWNER/REPO, HOST/OWNER/REPO or a URL.
export function parseGhRepoArg(arg, env = process.env) {
  if (!arg) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || /^[^/\s]+@[^:/\s]+:/.test(arg)) return parseGitHubUrl(arg, env);
  const parts = arg.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length === 2) return { host: 'github.com', owner: parts[0], repo: parts[1] };
  if (parts.length === 3) {
    return looksLikeGitHubHost(parts[0]) ? { host: parts[0].toLowerCase(), owner: parts[1], repo: parts[2] } : null;
  }
  return null;
}
