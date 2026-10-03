// Small helpers shared by every layer.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// An error whose message is safe to show. Messages are built from line
// numbers and paths, never from term text, because they can reach a CI log.
export class GuardError extends Error {}

export function home(env = process.env) {
  return env.HOME || homedir();
}

export function expandHome(path, env = process.env) {
  if (path === '~') return home(env);
  if (path.startsWith('~/')) return join(home(env), path.slice(2));
  return path;
}

export function resolveFrom(base, path, env = process.env) {
  const expanded = expandHome(path, env);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

// Files read for scanning are capped so a stray `--body-file` pointing at a
// large binary cannot stall a hook past its timeout (a timed-out hook allows
// the tool call).
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Returns { text } for a readable text file, { missing: true } when it does
// not exist, { skipped: reason } for binaries and oversized files.
export function readTextFile(path) {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { missing: true };
    throw new GuardError(`cannot read ${path}: ${err.code}`);
  }
  if (!st.isFile()) return { skipped: 'not a regular file' };
  if (st.size > MAX_FILE_BYTES) return { skipped: 'larger than 8 MiB' };
  const buf = readFileSync(path);
  if (isBinary(buf)) return { skipped: 'binary' };
  return { text: buf.toString('utf8') };
}
