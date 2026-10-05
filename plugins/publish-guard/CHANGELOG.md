# Changelog

## 0.1.2

- A private term made of several alphanumeric tokens (`/Users/jdoe`,
  `acme corp`) now also matches those tokens in order with up to three other
  characters between them, or none. A path rewritten as a slug
  (`-Users-jdoe-Projects-x-`), `Users_jdoe`, `users.jdoe` and `usersjdoe` are
  caught; before, only the exact spelling was. Matching stays case-insensitive.
- The looser spellings must stand alone: a letter or digit touching either end
  of the match rules it out, so short tokens do not join across punctuation
  inside longer words. The exact spelling keeps matching anywhere, so nothing
  that matched before stops matching.
- Unchanged: one-token terms, `re:` terms, reserved-domain and email rules.

## 0.1.1

- Subdomains of the reserved example domains count as reserved.

## 0.1.0

- First release: private terms and non-allowed emails blocked at the Claude
  Code hook, in git hooks and in CI, for repositories of protected owners.
