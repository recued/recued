# Changelog

All notable changes to the public Recued source distribution will be recorded here.

Versions are calendar-based (`yy.m.d`, US Pacific) and name the day the source
checkpoint was cut. One entry per published export; the machine-readable
provenance for each — source commit, tree, payload digest, and what was omitted
— lives in `.recued-public-export.json`.

## 26.8.8 — 2026-08-08

One capability dominates this release: a Recued server can now ask *another*
Recued server for something, and get an honest answer back. Alongside it, a
spreadsheet or bank statement can become records without a vendor connection,
and about eighteen new review packs ask a question of a service you already pay
for.

### Added

- **Server-to-server exchange.** Your server can send a request to another
  person's Recued server — a project update, a question, a record — and that
  server answers under its own owner's rules. The part that took the longest was
  not sending; it was making the *failure* useful. "Refused" and "unreachable"
  are now different things, a guard that declines says so rather than implying
  you should try again later, and a peer that cannot reply says that instead of
  going quiet. A request that is worth retrying is retried on a schedule; one
  that is not is not. A recipe can ask what became of a message it sent.
- **Import a file of records in one call.** A CSV — a bank statement, an export
  from another tool, a spreadsheet you keep by hand — becomes records through a
  single gated call, written in batches rather than one row at a time. A
  thousand-row import used to mean a thousand separate writes and a thousand
  audit rows against a quota that evicts the oldest; it is now around ten.
- **Statement import**, which turns a downloaded bank or card statement into
  records without connecting the bank at all. For accounts with no API, or that
  you would rather not connect, the file you can already download is enough.
- **Around eighteen new review packs**, each asking one question of a service
  you are already paying for: Stripe receivables, Zendesk ticket counts, GitHub
  scan coverage, Sentry measured-versus-extrapolated numbers, Twilio and
  PagerDuty reachability, Xero's first-page ceiling, Datadog cost windows,
  LaunchDarkly flag debt, Vercel edge-config exposure, Intercom content
  freshness, Brevo list reach, Close activity time, Asana allocation,
  Elasticsearch access blind spots, OpenAI standing credentials, and PandaDoc
  webhook delivery.
- **Federated projects**, for a project whose participants are on different
  servers.

### Changed

- **You can see what a pack would be allowed to do before you install it.** The
  permissions a pack asks for are shown up front, and where a connection needs
  scopes registered with the provider, the app names them *before* you
  authorize rather than after the authorization fails.

### Fixed

- **Browser Back returns to the list.** On the recipes and data screens the
  device's own Back gesture went somewhere unexpected; it now goes where you
  came from.
- **A connection's slug is shown only when it tells you something** — when two
  connections would otherwise read identically.
- **A failed boot can report itself.** The web app's own content-security policy
  was blocking the script that reports a failed start, so the one case where you
  most need a message produced none.

### Performance

Four places where a screen or a background task read an entire table to find a
handful of rows: cancelling a consumer's queued dispatches, the owner's
pending-approvals view, the blob collector's scan for the small share of rows
that actually carry a blob, and the pinned-row count behind the MCP surface —
the last around 390 times cheaper. None of these changed what you see; they
change how long you wait for it, and they matter most on the servers that have
been running longest.

## 26.8.5 — 2026-08-05

Two things dominate this release. The web app is now measured against a phone
rather than assumed to work on one, and a path that had never actually completed
— issuing a certificate for your own domain from the server — now does.

### Fixed

- **The app fits a phone.** Long values — a contract id, a pack slug, a failure
  message, a reference path — used to push a whole page sideways off screen, so
  the content you were reading moved out from under you. Every surface is now
  measured at 280px and 390px wide and holds its column. Where a strip or a wide
  table is *meant* to scroll sideways, it still does; that is now a deliberate,
  marked exception rather than an accident.
- **Keyboard position is held when a transient notice closes.** Dismissing a
  result banner used to drop focus to the top of the page, which for a keyboard
  or screen-reader user meant losing your place entirely.
- **Touch targets and labels** across Automation, Packs, Recipes, Contracts,
  Connections, Chat, Data, Logs, Reception and Settings — repeated controls now
  have distinguishable names rather than a dozen identical "Retry"s.
- **Certificate issuance for a custom domain could not succeed.** The request was
  capped at 30 seconds, and the signing request used a key type no public
  certificate authority will sign. Both are fixed, failover now decays through
  every configured authority instead of stopping at the first, and recovering an
  account no longer consumes a single-use credential.
- **A published domain name now appears within seconds** of the name being
  claimed, rather than on the next scheduled pass. A server that cannot yet
  provision states why instead of appearing idle.
- A setting stored outside its own table applied nothing and reported nothing —
  it looked saved and did not take effect.

### Changed

- **Your own data is budgeted for a server, not a browser extension.** The stores
  that cannot be re-fetched — your records, your shared data, your memory — were
  limited to 50–100 MB while replaceable copies of remote data were allowed
  gigabytes. That is inverted: the irreplaceable stores now hold up to 5 GB each.
- **Memory and the activity trail are separate.** What you write and keep is
  never pruned. The run-history trail is bounded and drops its oldest entries.
  Previously one name covered both, which made it unclear what could be
  discarded.
- **Chat costs less per turn.** A turn is dominated by the catalog of available
  tools rather than by the conversation; the default now sends a lean core and
  fetches detail on demand.

### Added

- Around twenty new packs, including Snowflake, Databricks, BigQuery, Hex,
  Atlassian Compass, Vanta, Teamwork, Netlify, DigitalOcean, Postmark,
  VirusTotal, Readwise, MusicBrainz, Wikidata, Open Library, Open Food Facts and
  several public-data sources.
- Storage read-out and a Reclaim action under Server ▸ Maintenance, with
  per-surface usage shown in the server popover.
- Request signing for connections, so vendors that authenticate by signing each
  request rather than sending a fixed key can be bound.

### Performance

- The hourly storage check no longer sums the whole activity log; the database
  maintains the total, so the check is constant-time regardless of history size.
- Retention no longer re-scans the entire log once per deleted row.
- Reading the tail of a long chat scaled with conversation length — roughly 400×
  slower at two thousand turns. It is now bounded.
- Cache expiry, prefix invalidation and eviction use indexed range scans instead
  of full passes.

## 26.8.4 — 2026-08-04

Almost all of this release is one thing: work you have started stays yours. The
webclient used to lose in-progress edits, keyboard position, and pending actions
whenever a route repainted, a background read landed, or the page reloaded. That
is now held across every surface.

### Fixed

- **Unsaved work survives navigation, reload, and background repaints.** Drafts,
  filters, selections, pagers, and in-flight actions are retained per surface
  rather than discarded when something else finishes loading. This covers Chat,
  Data, Records, Recipes, Kitchen, Contracts, Connections, Packs, Approvals,
  Reception, Automation, Logs, and Settings.
- **Keyboard focus is owned rather than lost.** After an action completes, focus
  advances to whatever now matters instead of falling back to the page. Where an
  action is refused, focus returns to the control that asked for it, so a
  keyboard user is not left without a position.
- **A leave with unsaved work is confirmed, not silently discarded** — including
  on reload and on switching servers.
- A revoked device now leaves the roster. The revoke was recorded and the refresh
  that should have followed was aborted by an unhandled error, so the device kept
  appearing as active.
- Connections: the Authorize button no longer fails silently, the readiness
  checklist lists only what the owner must actually enter, and the callback URL
  shown is the one this client uses.
- Packs: "Installed only" now filters, and Install is no longer inert on an
  uninstalled pack.

### Added

- **Keyless open-data packs — nothing to sign up for.** Weather Desk (current
  conditions, a seven-day and an hour-by-hour outlook, a schedulable morning
  brief, and a here-without-naming-a-place lookup), air quality with pollen, IP
  geolocation, public flight positions, and case-law retrieval. These need no API
  key and no account.
- 36 further vendor packs and 28 recipes.
- Every recipe now declares the packs it calls, so an install knows what it
  depends on rather than discovering it at run time.

### Changed

- Recipe ids end with the platform they bind to (`check-weather-open-meteo`
  rather than `check-weather`), matching the rest of the corpus. This affects the
  ten open-data recipes added since the last release; nothing previously
  published was renamed.

## 26.8.2 — 2026-08-02

The bulk of this release is a hardening pass over every surface that accepts
work from outside the server, and a matching pass over failures that used to
pass silently.

### Security

- **Every inbound work path now has an explicit ceiling.** The pair/RPC
  WebSocket enforces per-client and global in-flight limits plus a maximum
  payload size; the MCP HTTP transport, trigger dispatch, webhook dispatch and
  reception intake each bound their own concurrent work. Public doors enforce
  per-token concurrency tiers, anonymous recipe cost is capped, paired recipe
  pressure is bounded, and form limits are enforced per source. Previously a
  single client — buggy or hostile — could enqueue without limit.
- Door dispatch authority is resolved once and pinned, and every authority axis
  is diffed rather than spot-checked.
- OAuth provider runtime origins are pinned.
- Providers reject malformed pagination state instead of continuing from it.

### Added

- **Server receipts reach the webclient.** Server-side action outcomes are
  carried into Attention, unresolved receipts can be reviewed and reconciled,
  and diagnosis hands off to the server controls that can act on it — so a
  failure that happened while nobody was looking is visible and actionable
  rather than lost.
- Work-entity sources gain a read-through posture, qualified source id routing,
  and required landing adapters; first-party task sources move into packs, so a
  source is declared the same way whether it ships with the server or with a
  pack (D-192).
- MCP persists approval continuations, so an approval that outlives the
  connection can still be resumed.

### Fixed

- Failures that were previously swallowed now surface: vault resume, watch
  polling, scheduler background work, and file/MCP credential-refresh
  persistence all report rather than fail quietly.
- IMAP reconnects drain instead of accumulating; vault sync edges are
  serialized; every listener branch is closed on shutdown.
- A resumed audit entry keeps its original start time.
- The release manifest is published at every known channel path, not only the
  declared ones. An edge-channel server resolves to stable when no edge channel
  is declared, but still fetches `/edge/manifest.json` — so a stable-only
  release previously 404'd every edge server's update check.

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
