# Changelog

## 1.1.0 — 2026-11-20

### Added
- **Results publication threshold** (`min_ballots_for_results`, 5 by default for new polls, editable on the management
  page and through the API): below it, results are hidden everywhere — voter page, live updates, organiser page, API,
  confirmation email — and only the ballot count is shown. In a nominative poll the organiser still sees everything;
  the threshold then applies to voters. Polls created before this version keep a threshold of 0.

## 1.0.0 — 2026-11-20

First public release.

### Added
- **REST API for organisers** (`/api/v1`): polls (list, create, read, update, close/reopen, delete), options (add as
  JSON or with an image, edit, set image, delete), live results, participants of nominative polls, email invitations.
  Token authentication (read-only or read-write scope, only the hash is stored), per-token rate limits, invitation
  quotas per organiser and service-wide, JSON errors, OpenAPI 3.1 spec (`/api/v1/openapi.json`) and docs (`/api/docs`).
  Voting itself is deliberately not exposed: every voter votes through their personal link.
- **API** menu to create and revoke tokens.
- Closing dates entered in the browser's time zone (`APP_TIMEZONE` for display, `Europe/Paris` by default).
- Email aliases of the same mailbox count as one voter (`+tag` everywhere; dots and `googlemail.com` for Gmail).
- Test suite (50 tests against a real PostgreSQL), ESLint, GitHub Actions CI (Node 22 and 24, audit, Docker build).
- Bilingual README with screenshots, MIT licence.

### Security and privacy
- Ballot secrecy enforced at the database level: link tokens stored as SHA-256 hashes; voter email kept only
  encrypted with a key derived from the voter's own link until the confirmation is sent, then erased; ballots carry no
  voter reference nor timestamp; vote dates rounded to the day. Existing databases are migrated.
- A ballot is refused if the poll switched between secret and nominative while it was displayed.
- One malformed URL no longer crashes the server (Express 5, UUID validation).
- Same-origin check on every browser write (CSRF), per-IP rate limiting, no open redirect, security headers,
  mandatory strong secrets in production, double-vote race closed with row locks.
- Dependencies upgraded; `npm audit` reports no vulnerability.

### Changed
- Node.js 22 or later is required.
- Docker image built from the lockfile, runs as a non-root user, with a health check that also checks the database.
