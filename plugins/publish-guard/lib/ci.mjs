// GitHub Actions entry point, driven by the reusable workflow in
// .github/workflows/publish-guard.yml. Event text arrives in GUARD_*
// environment variables (never interpolated into a script), the terms in a
// 0600 file written from the PUBLISH_GUARD_TERMS secret.
//
// CI logs and check results on a public repository are public. Two rules
// follow from that: findings are redacted like everywhere else, and text
// written by people without write access is never checked against the
// terms, because a pass/fail on their own comment would let anyone probe
// the private list one guess at a time.

import { basename } from 'node:path';
import { DEFAULT_EMAIL_PATTERNS, loadTerms } from './config.mjs';
import * as G from './git.mjs';
import { dedupe, formatReport, makeEmailPolicy, Scanner } from './scan.mjs';
import { GuardError } from './util.mjs';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function list(value, split) {
  return (value ?? '')
    .split(split)
    .map((s) => s.trim())
    .filter(Boolean);
}

function annotate(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function runCi(dir, { env = process.env, io }) {
  const event = env.GUARD_EVENT || env.GITHUB_EVENT_NAME || '';
  const assoc = {
    pull_request: env.GUARD_PR_ASSOCIATION,
    issues: env.GUARD_ISSUE_ASSOCIATION,
    issue_comment: env.GUARD_COMMENT_ASSOCIATION,
    pull_request_review: env.GUARD_REVIEW_ASSOCIATION,
    pull_request_review_comment: env.GUARD_COMMENT_ASSOCIATION,
  }[event];
  const trusted = event === 'push' || TRUSTED.has(assoc ?? '');

  const patterns = [...DEFAULT_EMAIL_PATTERNS, ...list(env.GUARD_ALLOWED_EMAIL_PATTERNS, /\n/)].map((p, i) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      throw new GuardError(`allowed-email-patterns entry ${i + 1 - DEFAULT_EMAIL_PATTERNS.length} is not a valid regular expression`);
    }
  });
  const emailPolicy = makeEmailPolicy({ allowedEmails: list(env.GUARD_ALLOWED_EMAILS, /[\s,]+/), allowedEmailPatterns: patterns });
  let terms = [];
  if (env.GUARD_TERMS_FILE && trusted) terms = loadTerms(env.GUARD_TERMS_FILE);
  const scanner = new Scanner({ terms, emailPolicy, termsLabel: env.GUARD_TERMS_FILE ? basename(env.GUARD_TERMS_FILE) : 'terms.txt' });

  if (!env.GUARD_TERMS_FILE) {
    io.out('::warning title=publish-guard::PUBLISH_GUARD_TERMS is not available to this run (fork pull requests never get secrets), so private terms were NOT checked. Email identities still were.');
  } else if (!trusted) {
    io.out(`::notice title=publish-guard::Text by a ${assoc || 'non-collaborator'} author is not checked against private terms, so this result cannot be used to probe them. Email identities still were.`);
  } else if (!terms.length) {
    io.out('::warning title=publish-guard::PUBLISH_GUARD_TERMS holds no terms, so private terms were NOT checked.');
  }

  const genv = G.gitEnv(env);
  const findings = [];
  const range = (revs) => {
    const r = G.scanCommits(scanner, dir, revs, { env: genv });
    io.out(`checked ${r.commits} commit(s)`);
    findings.push(...r.findings);
  };
  // Titles, bodies and comments by people without write access are skipped
  // entirely: the owner cannot fix them, and checking them is the probe
  // described at the top of this file.
  const text = (value, where) => {
    if (value && trusted) findings.push(...scanner.message(value, where));
  };

  switch (event) {
    case 'push': {
      const before = env.GUARD_BEFORE ?? '';
      const after = env.GUARD_AFTER ?? '';
      const ref = env.GUARD_REF ?? '';
      if (!after || G.ZERO_SHA.test(after)) {
        io.out('ref deleted; nothing to check');
        break;
      }
      if (ref.startsWith('refs/tags/') && G.objectType(dir, after, genv) === 'tag') {
        findings.push(...G.scanTagObject(scanner, dir, after, ref.slice(10), genv));
      }
      if (before && !G.ZERO_SHA.test(before) && G.objectType(dir, before, genv) === 'commit') {
        range([after, '--not', before]);
      } else {
        // New branch or tag (zero before-SHA), or history we do not have:
        // everything not already on another branch of this repository.
        const own = ref.startsWith('refs/heads/') ? `refs/remotes/origin/${ref.slice(11)}` : null;
        const others = G.listRefs(dir, ['refs/remotes/origin/'], genv)
          .filter((r) => r.name !== own && !r.name.endsWith('/HEAD'))
          .map((r) => r.sha);
        range([after, ...(others.length ? ['--not', ...others] : [])]);
      }
      break;
    }
    case 'pull_request':
    case 'pull_request_target':
      text(env.GUARD_PR_TITLE, 'pull request title');
      text(env.GUARD_PR_BODY, 'pull request body');
      if (env.GUARD_PR_HEAD) {
        // The base branch may have moved since the event; without its old tip,
        // exclude every branch the checkout fetched instead.
        const base = env.GUARD_PR_BASE && G.objectType(dir, env.GUARD_PR_BASE, genv) === 'commit' ? [env.GUARD_PR_BASE] : ['--remotes=origin'];
        range([env.GUARD_PR_HEAD, '--not', ...base]);
      }
      break;
    case 'issues':
      text(env.GUARD_ISSUE_TITLE, 'issue title');
      text(env.GUARD_ISSUE_BODY, 'issue body');
      break;
    case 'issue_comment':
    case 'pull_request_review_comment':
      text(env.GUARD_COMMENT_BODY, 'comment');
      break;
    case 'pull_request_review':
      text(env.GUARD_REVIEW_BODY, 'review');
      break;
    default:
      io.out(`publish-guard has nothing to check for ${event || 'this'} event`);
  }

  const all = dedupe(findings);
  if (!all.length) {
    io.out('publish-guard: clean');
    return 0;
  }
  const lines = formatReport(all, scanner, { limit: 200 });
  for (const l of lines) io.out(l);
  io.out(`::error title=publish-guard::${annotate(`${all.length} finding(s); see the log above. Terms are never printed; ███ marks each match.`)}`);
  return 1;
}
