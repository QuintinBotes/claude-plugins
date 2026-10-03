// Loads ~/.config/publish-guard/config.json (or $PUBLISH_GUARD_CONFIG) and
// the terms file it names. The config is the only place protected owners and
// allowed emails are defined; the terms file is the only place terms live.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeEmailPolicy, parseTerms, redact, Scanner } from './scan.mjs';
import { expandHome, GuardError, home, resolveFrom } from './util.mjs';

// GitHub's own addresses: noreply identities, the web-flow committer, and
// the Signed-off-by trailer Dependabot adds to every commit.
export const DEFAULT_EMAIL_PATTERNS = [
  '@users\\.noreply\\.github\\.com$',
  '^noreply@github\\.com$',
  '^support@github\\.com$',
  '@example\\.(com|org|net)$',
];

export function configPath(env = process.env) {
  if (env.PUBLISH_GUARD_CONFIG) return resolveFrom(process.cwd(), env.PUBLISH_GUARD_CONFIG, env);
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, env) : join(home(env), '.config');
  return join(base, 'publish-guard', 'config.json');
}

function compilePatterns(list, label) {
  return list.map((p, i) => {
    try {
      return new RegExp(String(p), 'i');
    } catch {
      throw new GuardError(`${label}: allowed_email_patterns[${i}] is not a valid regular expression`);
    }
  });
}

function stringList(value, field, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new GuardError(`${label}: ${field} must be an array of strings`);
  }
  return value;
}

// Returns { missing: true, path } when there is no config file at all, so
// callers can tell "not set up" (nothing is protected) from "broken" (fail
// closed). Throws GuardError for a config that exists but cannot be used.
export function loadConfig({ env = process.env, path = configPath(env) } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true, path };
    throw new GuardError(`cannot read ${path}: ${err.code}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GuardError(`${path} is not valid JSON`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GuardError(`${path} must hold a JSON object`);
  const label = basename(path);
  const termsFile = raw.terms_file ? resolveFrom(dirname(path), raw.terms_file, env) : join(dirname(path), 'terms.txt');
  return {
    path,
    protectedOwners: stringList(raw.protected_owners, 'protected_owners', label).map((o) => o.toLowerCase()),
    allowedEmails: stringList(raw.allowed_emails, 'allowed_emails', label),
    allowedEmailPatterns: compilePatterns(stringList(raw.allowed_email_patterns, 'allowed_email_patterns', label), label),
    termsFile,
    // gh pr merge without --author-email lets GitHub pick the account's
    // default commit email, which is how a work address reached history.
    requireMergeAuthorEmail: raw.require_merge_author_email !== false,
  };
}

export function isProtectedOwner(config, owner) {
  return Boolean(owner) && config.protectedOwners.includes(String(owner).toLowerCase());
}

let cachedTerms = null;

export function loadTerms(termsFile) {
  if (cachedTerms?.file === termsFile) return cachedTerms.terms;
  let text;
  try {
    text = readFileSync(termsFile, 'utf8');
  } catch (err) {
    throw new GuardError(`cannot read terms file ${termsFile}: ${err.code}`);
  }
  const terms = parseTerms(text, basename(termsFile));
  cachedTerms = { file: termsFile, terms };
  return terms;
}

// Error messages can quote git's stderr, which names refs and paths. Once
// terms are loaded they are redacted before anything is printed.
export function redactLoaded(text) {
  return cachedTerms ? redact(text, cachedTerms.terms) : text;
}

// A Scanner for this config. Terms are required: a protected repository with
// an unreadable terms file must fail closed, not scan for nothing.
export function scannerFor(config) {
  return new Scanner({
    terms: loadTerms(config.termsFile),
    termsLabel: basename(config.termsFile),
    emailPolicy: makeEmailPolicy(config),
  });
}
