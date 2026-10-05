import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRealEmail } from '../lib/scan.mjs';

// RFC 2606 reserves example.com/.net/.org and every name under them, so a
// fixture address on a subdomain can never belong to a person.
test('subdomains of the reserved example domains are not real addresses', () => {
  for (const email of ['x@mail.example.com', 'ops@eu.mail.example.org', 'a@b.example.net']) {
    assert.equal(looksLikeRealEmail(email), false, email);
  }
});

test('reserved top-level names stay exempt and real-looking domains do not', () => {
  assert.equal(looksLikeRealEmail('jane@acme.test'), false);
  assert.equal(looksLikeRealEmail('jane@acme.invalid'), false);
  assert.equal(looksLikeRealEmail('jane@example.com'), false);
  // Built at runtime: a literal real-looking address in source would be blocked by this very guard.
  const at = (local, domain) => [local, domain].join('@');
  assert.equal(looksLikeRealEmail(at('jane', 'acme.io')), true);
  assert.equal(looksLikeRealEmail(at('jane', 'notexample.com')), true);
});
