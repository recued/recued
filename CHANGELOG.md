# Changelog

All notable changes to the public Recued source distribution will be recorded here.

Versions are calendar-based (`yy.m.d`, US Pacific) and name the day the source
checkpoint was cut. One entry per published export; the machine-readable
provenance for each — source commit, tree, payload digest, and what was omitted
— lives in `.recued-public-export.json`.

## 26.8.1 — 2026-08-01

### Security

- **`nodemailer` is now `^9.0.3`.** The advisory affects the whole `8.x` line
  (`<=9.0.0`), so no patch release could clear it. The IMAP/SMTP send path
  submits with the exact option named in it — a message-level `raw` body, which
  bypassed `disableFileAccess` / `disableUrlAccess` and allowed arbitrary file
  read and full-response SSRF in the delivered message.
- `ws` is now `^8.21.1`, closing a memory-exhaustion denial of service reachable
  from the pairing and RPC transport, and `imapflow` moves to `1.6.5`. The
  dependency projection also picks up `libmime`, `mailsplit`, `iconv-lite`,
  `semver`, `socks`, and `ip-address`.

### Added

- **Pack-owned records (D-221).** Packs declare fixed relational storage with
  pack-wide version anchoring, and the reachable list operations hand back the
  ids they list, so a listed row can be acted on without a second lookup.
- **MCP as a declared surface (D-225).** Surfaces are declared rather than
  inferred, and their kernel packs are generated from that declaration.
- Recipe variables can be supplied as invocation arguments, with a rendered
  filter block for the caller (D-222); publishers may suggest connection values
  as hints without widening the schema a user controls (D-223).
- The webclient gains recovery flows for interrupted work — resuming paused and
  resolved recovery intents, reorienting stale ones, and recovering failed
  rechecks from Attention.
- `CLAUDE.md`, a short orientation file for AI coding assistants working in this
  repository. It links `ARCHITECTURE.md` and `CONTRIBUTING.md` rather than
  restating them.

### Changed

- **BREAKING — Tier-1 primitives are now gated by contract on the MCP wire and
  the chat channel (D-228.5).** Every tier-1 registry dispatch resolves through
  the operation admission gate. This is a second axis, not a replacement: a
  token's checklist says what that token may use, the contract says what the
  door may ever be granted, and both must pass — so a token can never widen past
  its contract. An owner with an unbound token and a wildcard door still admit.
  A one-time grandfather writes an explicit grant per previously-usable
  primitive, because the author default is fail-closed for scoped doors and
  customer instances and no such row could have existed before this release —
  without it, upgrading would have silently stripped operations like
  `mail.search` and `recipe.run` from every scoped contract.
- Recipe arguments now declare optionality honestly. 108 arguments across the
  corpus were presented to callers as optional when they were not.
- The release manifest is served per channel at
  `releases.recued.com/<channel>/manifest.json`. The bytes are identical at
  every path — one signature, one sequence, every channel inside each copy — so
  signature verification and the anti-replay floor are unchanged.
- The update check identifies itself as `recued/<version> (<platform>;
  <distribution-channel>)`. Every field is already computed for the check
  itself, nothing new is collected, and nothing in it is per-instance: two
  servers alike in those fields send byte-identical requests.

### Fixed

- The baked Docker image could not start — it rebuilt the wrong SQLite driver.
- A recipe-keyed watcher could not cross the pair RPC, and a webhook queue is
  now owned by the recipe draining it (D-228).
- The Learning panel crashed on a field that had stopped claiming a route
  (D-219).

## 26.7.26 — 2026-07-26

### Added

- Owner feedback on a chat execution can be retracted:
  `chat.execution.feedback.retract` withdraws one exact feedback fact and
  deterministically recompiles the affected span. As with the rest of the
  feedback surface, the caller names no case or feedback row.
- An `element.changed` shorthand for DOM watch triggers, alongside the existing
  trigger sugar.

### Changed

- `@recued/contracts` now declares `sideEffects`, so bundlers can tree-shake
  the modules that have none.
- Execution-case handling is tightened throughout: case grounding, experiment
  invariants, critic behaviour, retrieval, and the case vocabulary.

## 26.7.25 — 2026-07-25

### Added

- Encryption at rest for the server realm database, with production blobs keyed
  by default and a single database-open chokepoint.
- The Day-1 foundation packs and the recipes they reference now ship as JSON
  under `community/`, so the authoring guides have a local worked example.
- `ARCHITECTURE.md` and `CONTRIBUTING.md`.

### Changed

- Cloud document-provider files now have one credential authority: a connection
  owns enrollment, refresh, and revocation. The `collection.file.reauth` RPC is
  removed — re-consent goes through Data → Files → Add connection.
- The README points at <https://recued.com/docs> for installing, pairing, and
  authoring.

### Removed

- Internal benchmark tooling is no longer part of the published tree.

## 26.7.3 — 2026-07-20

### Added

- Initial AGPL-3.0-only public source export: the self-hosted server, the
  webclient, and the workspace packages they are built from.
- Reproducible public dependency projection and committed-source provenance
  metadata.
