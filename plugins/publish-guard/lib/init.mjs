// `publish-guard init`: creates the config and terms templates with 0600
// permissions. It never overwrites, because both files hold things the user
// typed by hand and the terms exist nowhere else.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath, DEFAULT_EMAIL_PATTERNS } from './config.mjs';
import { resolveFrom } from './util.mjs';

const TERMS_TEMPLATE = `# publish-guard private terms. Never commit this file or paste it anywhere.
# One term per line, matched case-insensitively as a substring. A term of
# several parts (acme-internal) also matches with other separators or none
# between them (acme_internal, acme internal, acmeinternal).
# Prefix a line with "re:" for a JavaScript regular expression.
# Avoid generic words (they cause false positives); qualify them instead.
#
# Examples (replace with your own):
# acme-internal
# re:acme[ ._-]?corp
`;

function writeNew(path, content, io) {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  io.out(`created ${path}`);
}

function checkMode(path, io) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) io.err(`warning: ${path} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it`);
}

export function init({ env = process.env, owners = [], emails = [], io }) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let termsFile = resolveFrom(dirname(path), 'terms.txt', env);
  if (existsSync(path)) {
    io.out(`kept existing ${path}`);
    checkMode(path, io);
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (raw.terms_file) termsFile = resolveFrom(dirname(path), raw.terms_file, env);
    } catch {
      io.err(`warning: ${path} is not valid JSON; fix it by hand`);
    }
  } else {
    const config = {
      protected_owners: owners.length ? owners : ['your-github-user'],
      allowed_emails: emails.length ? emails : ['you@personal.example'],
      allowed_email_patterns: [...DEFAULT_EMAIL_PATTERNS, '^noreply@anthropic\\.com$'],
      terms_file: termsFile,
    };
    writeNew(path, `${JSON.stringify(config, null, 2)}\n`, io);
  }
  if (existsSync(termsFile)) {
    io.out(`kept existing ${termsFile}`);
    checkMode(termsFile, io);
  } else {
    mkdirSync(dirname(termsFile), { recursive: true, mode: 0o700 });
    writeNew(termsFile, TERMS_TEMPLATE, io);
  }
  io.out('Next: edit both files, then run publish-guard install-git-hooks in each repository you publish from.');
  return 0;
}
