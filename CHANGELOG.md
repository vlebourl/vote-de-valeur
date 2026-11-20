# Changelog

## 1.2.1 — 2026-11-20

### Fixed
- A new-choice notice no longer invalidates the voter's existing link: it adds an extra personal link (stored as a
  hash), and the link from the confirmation email keeps working. A new link requested by the voter still replaces all
  of their links.

## 1.2.0 — 2026-11-20

### Added
- **Choices added after a vote.** Voters can opt in to be notified when a choice is added ("Prévenez-moi si un choix
  est ajouté"). The organiser's *Notify* button (or `POST /api/v1/polls/{pollId}/notifications`) emails each concerned
  voter a new personal link to rate only the choices added since their vote; their other scores stay final. Voters who
  did not opt in are offered the same on their results page. Added scores go into an anonymous supplementary ballot,
  which does not count as an extra voter. In name mode, entering the same name again opens the new choices.
- Opt-in addresses are encrypted with a server-derived key, stored apart from ballots, never shown to the organiser
  (counts only) and erased when the poll closes (status or closing date, checked hourly).
- The ballot carries a signed list of the choices shown: a score is required for each of them (no empty or partial
  ballot), and only those count as rated; an option added while a ballot is open stays to be rated.
- Before submitting, voters tick "I understand I can neither change nor review my vote" and, with JavaScript, confirm
  a recap of their scores.
- **Per-choice threshold**: a choice rated by fewer voters than the publication threshold (typically one added after
  votes) shows no total and no rank.
- **"Vos données" page** explaining what is kept, how, for how long, and who could link an email to a vote — including
  the server host, who is not protected against.

### Changed
- Confirmation emails no longer contain the voter's scores (nor results): only that the vote was recorded and the
  personal link.
- Name mode: re-entering a name never opens a supplement (no takeover); supplements go through the personal link.
- Closing is re-checked under lock when recording a vote or sending a notice; reopening or extending a closed poll
  erases leftover notification addresses first. Notification and invitation emails share one hourly quota per
  organiser, in the interface and the API, sending in batches and reporting how many remain.
- Votes cast before 1.2 are offered only the options created after the upgrade.

## 1.1.1 — 2026-11-20

### Added
- Favicon (SVG, with PNG, ICO and Apple touch icon fallbacks) drawn from the site's −2…+2 bars logo.

## 1.1.0 — 2026-11-20

### Added
- **Results publication threshold** (`min_ballots_for_results`, 5 by default for new polls, editable on the management
  page and through the API): below it, results are hidden everywhere — voter page, live updates, organiser page, API,
  confirmation email — and only the ballot count is shown. In a nominative poll the organiser still sees everything;
  the threshold then applies to voters. Polls created before this version keep a threshold of 0.
- The results page always shows the number of voters, with an explicit message while it is below the threshold.

### Changed
- The vote confirmation email no longer contains any result: only the voter's own scores and their personal results
  link (an email is forwarded and kept; totals frozen on a few ballots would reveal votes).

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
