// The one scanner behind every layer: Claude Code hook, git hooks, CI and
// audit. It finds private terms and email addresses in text and returns
// findings whose text has already been redacted. Nothing that leaves this
// module may contain a matched term, because reports end up in CI logs on
// public repositories and in hook reasons the model reads.

import { GuardError } from './util.mjs';

export const BLOCK = '███';

const EXCERPT_RADIUS = 40;

// --- Terms -----------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Terms file format: one term per line, case-insensitive substring. Lines
// starting with "re:" are JavaScript regular expressions (also
// case-insensitive). Blank lines and lines starting with "#" are ignored.
export function parseTerms(text, label = 'terms.txt') {
  const terms = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const s = rawLine.trim();
    if (!s || s.startsWith('#')) return;
    const line = i + 1;
    let re;
    if (s.startsWith('re:')) {
      try {
        re = new RegExp(s.slice(3), 'gi');
      } catch {
        // The engine's own message quotes the pattern, so it is not passed on.
        throw new GuardError(`${label} line ${line}: invalid regular expression`);
      }
      if (re.test('')) throw new GuardError(`${label} line ${line}: regular expression matches empty text`);
      re.lastIndex = 0;
    } else {
      re = new RegExp(escapeRe(s), 'gi');
    }
    terms.push({ ordinal: terms.length + 1, line, re });
  });
  return terms;
}

function rawMatches(text, terms, out) {
  for (const term of terms) {
    const re = term.re;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push([m.index, m.index + m[0].length, term]);
    }
  }
  return out;
}

// Text as a reader sees it: wrapped lines joined ("acme\ncorp" reads as
// "acme corp", "acme-\ninternal" as "acme-internal"), every whitespace run a
// single space, Unicode dashes (models write U+2011 in hyphenated words) as
// "-", and invisible characters (zero-width, soft hyphen) dropped. `segs`
// maps it back: [normalized start, original start, original end, identity]
// per run of unchanged text or per replaced character. Null when the text
// would not change.
const NEEDS_NORMALIZING = /\s{2,}|[^\S ]|[\u00ad\u200b-\u200d\u2060\ufeff\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/;
const SPECIAL = /[\s\u00ad\u200b-\u200d\u2060\ufeff\u2010-\u2015\u2212\ufe58\ufe63\uff0d-]/g;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/;
const BLANK = /[\s\u00ad\u200b-\u200d\u2060\ufeff]/;
const BREAK_AFTER_DASH = /[ \t\u00ad\u200b-\u200d\u2060\ufeff]*\r?\n[\s\u00ad\u200b-\u200d\u2060\ufeff]*/y;

export function normalizeForMatch(text) {
  if (!NEEDS_NORMALIZING.test(text)) return null;
  const parts = [];
  const segs = [];
  let n = 0;
  let i = 0;
  const keep = (to) => {
    if (to <= i) return;
    parts.push(text.slice(i, to));
    segs.push([n, i, to, true]);
    n += to - i;
  };
  SPECIAL.lastIndex = 0;
  let m;
  while ((m = SPECIAL.exec(text)) !== null) {
    const k = m.index;
    const c = text[k];
    let next = k + 1;
    let ch;
    if (INVISIBLE.test(c)) {
      ch = '';
    } else if (c === ' ' && !BLANK.test(text[next] ?? 'x')) {
      continue;
    } else if (/\s/.test(c)) {
      while (next < text.length && BLANK.test(text[next])) next++;
      ch = ' ';
    } else {
      BREAK_AFTER_DASH.lastIndex = next;
      const br = BREAK_AFTER_DASH.exec(text);
      if (!br && c === '-') continue;
      if (br) next += br[0].length;
      ch = '-';
    }
    keep(k);
    if (ch) {
      parts.push(ch);
      segs.push([n, k, next, false]);
      n += 1;
    }
    i = next;
    SPECIAL.lastIndex = next;
  }
  keep(text.length);
  return { text: parts.join(''), segs };
}

// The original span [start, end) that normalized span [s, e) stands for.
function originalSpan(norm, s, e) {
  const find = (j) => {
    let lo = 0;
    let hi = norm.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (norm.segs[mid][0] <= j) lo = mid;
      else hi = mid - 1;
    }
    return norm.segs[lo];
  };
  const a = find(s);
  const b = find(e - 1);
  return [a[3] ? a[1] + (s - a[0]) : a[1], b[3] ? b[1] + (e - 1 - b[0]) + 1 : b[2]];
}

// All matches of all terms as [start, end, term], sorted by start: matches
// in the text as written, plus those that only appear once it is normalized
// (a term wrapped across lines or written with a Unicode dash), mapped back
// to the span of the original text they cover.
export function findTermMatches(text, terms) {
  const out = [];
  if (!text) return out;
  rawMatches(text, terms, out);
  const norm = normalizeForMatch(text);
  if (norm) {
    const direct = out.length;
    for (const [s, e, term] of rawMatches(norm.text, terms, [])) {
      const [os, oe] = originalSpan(norm, s, e);
      let dup = false;
      for (let k = 0; k < direct && !dup; k++) dup = out[k][2] === term && out[k][0] < oe && os < out[k][1];
      if (!dup) out.push([os, oe, term]);
    }
  }
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  return out;
}

function mergeIntervals(matches) {
  const merged = [];
  for (const [s, e] of matches) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function replaceIntervals(text, intervals, at = -1) {
  let out = '';
  let cursor = 0;
  let pos = -1;
  for (const [s, e] of intervals) {
    if (pos < 0 && at >= 0 && at < s) pos = out.length + (at - cursor);
    out += text.slice(cursor, s);
    if (pos < 0 && at >= s && at < e) pos = out.length;
    out += BLOCK;
    cursor = e;
  }
  if (pos < 0 && at >= 0) pos = out.length + (at - cursor);
  out += text.slice(cursor);
  return { text: out, pos };
}

// Replaces every term match with BLOCK. Repeats until stable, because a
// replacement can create a new match for a regex term with anchors or word
// boundaries.
export function redact(text, terms) {
  if (!text || !terms?.length) return text;
  let out = String(text);
  for (let pass = 0; pass < 4; pass++) {
    const matches = findTermMatches(out, terms);
    if (!matches.length) return out;
    out = replaceIntervals(out, mergeIntervals(matches)).text;
  }
  return out;
}

function clean(s) {
  // Control characters would let a crafted line rewrite the terminal or a CI
  // log line; tabs and newlines just make excerpts unreadable.
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

// A one-line excerpt around position `at` of `line`, with every term
// redacted before and after cutting. `extra` holds [start, end] spans in
// line coordinates to redact as well: the parts of matches that continue
// onto a neighbouring line, which the line alone does not match.
export function excerpt(line, at, terms, extra = []) {
  const own = findTermMatches(line, terms).map(([s, e]) => [s, e]);
  const intervals = mergeIntervals([...own, ...extra].sort((a, b) => a[0] - b[0] || b[1] - a[1]));
  const { text, pos } = replaceIntervals(line, intervals, at);
  const start = Math.max(0, pos - EXCERPT_RADIUS);
  const end = Math.min(text.length, pos + BLOCK.length + EXCERPT_RADIUS);
  let cut = clean(text.slice(start, end)).trim();
  if (start > 0) cut = `…${cut}`;
  if (end < text.length) cut = `${cut}…`;
  return redact(cut, terms);
}

// --- Line bookkeeping -------------------------------------------------------

function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function locate(starts, text, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  const start = starts[lo];
  const nl = text.indexOf('\n', start);
  const end = nl === -1 ? text.length : nl;
  return { line: lo + 1, start, lineText: text.slice(start, end) };
}

// --- Emails -----------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

// Domains that never belong to a person (RFC 2606 / 6761 names), and
// "domains" that are really file names such as icon@2x.png.
const RESERVED_DOMAIN = /(^|\.)(example|test|invalid|localhost|local)$|(^|\.)example\.(com|org|net)$/i;
const FILE_TLD = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'css', 'scss', 'less', 'json', 'md', 'html', 'htm', 'txt', 'yml', 'yaml', 'toml', 'lock', 'map', 'vue',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'sh', 'zip', 'gz', 'tgz', 'pdf', 'xml', 'wasm', 'csv',
]);
// `git@host:` is an SSH login; `url.git@github.com:` is a git config key.
const ROBOT_LOCAL = /(^|\.)git$|^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon)$/i;

export function maskEmail(email, terms) {
  const at = email.lastIndexOf('@');
  if (at < 1) return redact(email, terms);
  return `${email[0]}***@${redact(email.slice(at + 1), terms)}`;
}

export function makeEmailPolicy({ allowedEmails = [], allowedEmailPatterns = [] } = {}) {
  const exact = new Set(allowedEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const patterns = allowedEmailPatterns;
  return {
    isAllowed(email) {
      const e = String(email).trim().toLowerCase();
      if (exact.has(e)) return true;
      return patterns.some((re) => {
        re.lastIndex = 0;
        return re.test(e);
      });
    },
  };
}

// Content rule: only addresses that look like a real person's mailbox and
// are not allowed. Identities and trailers use the strict rule instead.
export function looksLikeRealEmail(email, before = '') {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (ROBOT_LOCAL.test(local)) return false;
  if (RESERVED_DOMAIN.test(domain)) return false;
  if (FILE_TLD.has(domain.slice(domain.lastIndexOf('.') + 1))) return false;
  // user@host inside a URL (https://token@github.com/...) is credentials or
  // an SSH login, not an address.
  if (/:\/\/[^\s/]*$/.test(before)) return false;
  return true;
}

// --- Findings ---------------------------------------------------------------
//
// { kind: 'term',  where, line?, ordinal, termLine, excerpt }
// { kind: 'email', where, line?, email (masked), rule: 'identity'|'trailer'|'content' }
// { kind: 'error', where, message }

const TRAILER_RE = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;

export class Scanner {
  constructor({ terms = [], emailPolicy = makeEmailPolicy(), termsLabel = 'terms.txt', termsChecked = true } = {}) {
    this.terms = terms;
    this.emails = emailPolicy;
    this.termsLabel = termsLabel;
    this.termsChecked = termsChecked;
  }

  redact(text) {
    return redact(text, this.terms);
  }

  // Scans free text. `emails`: 'content' (flag real-looking, non-allowed
  // addresses), 'trailers' (content rule plus the strict rule on trailer
  // lines such as Co-authored-by), or 'none'.
  text(text, where, { emails = 'content', lineBase = 0, numbered = true } = {}) {
    const findings = [];
    if (text == null || text === '') return findings;
    text = String(text);
    const starts = lineIndex(text);
    const lineOf = (offset) => locate(starts, text, offset);
    const seen = new Set();
    const matches = findTermMatches(text, this.terms);
    for (const [s, , term] of matches) {
      const loc = lineOf(s);
      const key = `${term.ordinal}:${loc.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lineEnd = loc.start + loc.lineText.length;
      const spill = matches
        .filter(([a, b]) => a < lineEnd && b > loc.start)
        .map(([a, b]) => [Math.max(a, loc.start) - loc.start, Math.min(b, lineEnd) - loc.start])
        .filter(([a, b]) => b > a);
      findings.push({
        kind: 'term',
        where,
        line: numbered ? loc.line + lineBase : undefined,
        ordinal: term.ordinal,
        termLine: term.line,
        excerpt: excerpt(loc.lineText, s - loc.start, this.terms, spill),
      });
    }
    if (emails === 'none') return findings;

    const strictLines = new Set();
    if (emails === 'trailers') {
      starts.forEach((start, i) => {
        const nl = text.indexOf('\n', start);
        const lineText = text.slice(start, nl === -1 ? text.length : nl);
        const m = TRAILER_RE.exec(lineText);
        if (!m || !/-by$|^cc$/i.test(m[1])) return;
        strictLines.add(i + 1);
        // Trailer identities are taken as written, even ones that do not
        // look like real addresses (x@localhost), since git records them.
        let found = [...m[2].matchAll(/<([^<>\s]+@[^<>\s]*)>/g)].map((x) => x[1]);
        if (!found.length) found = m[2].match(EMAIL_RE) ?? [];
        for (const e of found) {
          if (!this.emails.isAllowed(e)) {
            findings.push(this.emailFinding(e, where, numbered ? i + 1 + lineBase : undefined, 'trailer'));
          }
        }
      });
    }
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(text)) !== null) {
      const loc = lineOf(m.index);
      if (strictLines.has(loc.line)) continue;
      if (this.emails.isAllowed(m[0])) continue;
      if (!looksLikeRealEmail(m[0], text.slice(Math.max(0, m.index - 200), m.index))) continue;
      findings.push(this.emailFinding(m[0], where, numbered ? loc.line + lineBase : undefined, 'content'));
    }
    return findings;
  }

  // A commit or tag message: terms, trailer identities, addresses in prose.
  message(text, where) {
    return this.text(text, where, { emails: 'trailers' });
  }

  // "Name <email>" from commit metadata: terms in either part, and the
  // address must be allowed.
  identity(name, email, where) {
    const findings = [];
    for (const f of this.text(`${name ?? ''} <${email ?? ''}>`, where, { emails: 'none', numbered: false })) {
      findings.push(f);
    }
    if (email == null || email === '') {
      findings.push({ kind: 'error', where, message: 'identity has no email address' });
    } else if (!this.emails.isAllowed(email)) {
      findings.push(this.emailFinding(email, where, undefined, 'identity'));
    }
    return findings;
  }

  emailFinding(email, where, line, rule) {
    return { kind: 'email', where, line, email: maskEmail(email, this.terms), rule };
  }
}

// --- Reporting --------------------------------------------------------------

const RULE_TEXT = {
  identity: 'is not an allowed commit identity',
  trailer: 'in a trailer is not allowed',
  content: 'is not allowed',
};

export function formatFinding(f, scanner) {
  const at = f.line ? `${f.where}, line ${f.line}` : f.where;
  let s;
  if (f.kind === 'term') {
    s = `${at}: private term #${f.ordinal} (${scanner.termsLabel} line ${f.termLine}): ${f.excerpt}`;
  } else if (f.kind === 'email') {
    s = `${at}: email ${f.email} ${RULE_TEXT[f.rule] ?? 'is not allowed'}`;
  } else {
    s = `${at}: ${f.message}`;
  }
  // Last line of defence: where, message and paths can carry text too.
  return scanner.redact(clean(s));
}

// Collapses identical findings (the same term on the same excerpt reported
// from two sources) so reports stay short.
export function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = JSON.stringify([f.kind, f.where, f.line, f.ordinal, f.excerpt, f.email, f.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatReport(findings, scanner, { limit = Infinity } = {}) {
  const lines = findings.slice(0, limit).map((f) => formatFinding(f, scanner));
  if (findings.length > limit) lines.push(`… and ${findings.length - limit} more`);
  return lines;
}
