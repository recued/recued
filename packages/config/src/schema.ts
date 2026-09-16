/** The authoritative runtime-schema registry. Adding a field means
 *  appending one entry here; the TOML loader, env parser, validator,
 *  and `setConfigField` bridge all pick it up automatically. */

import type { ScalarSchemaEntry } from './types.js';

/** Every runtime-editable config key. Keys are literal dotted strings
 *  (TOML-quoted in the file); values are scalars only (string, number,
 *  boolean, or a fixed enum). */
export const RUNTIME_SCHEMA = [
  // ─── Privacy ─────────────────────────────────────────────────
  {
    key: 'privacy.auto_pii_protection',
    section: 'Privacy',
    label: 'Alias personal data before sending it to models',
    type: 'boolean',
    default: true,
    description:
      'On by default. Recued rewrites recipes at dispatch so personal data — names, emails, phone numbers — is replaced with aliases before any model sees it, then restored in the result. Turn this off only to compare model behaviour with and without aliasing: while it is off, recipes send personal data to models UNALIASED, and recipe disclosures stop claiming auto-protection. The server prints a warning on every boot while it is off.',
  },
  // ─── LLM ─────────────────────────────────────────────────────
  {
    key: 'llm.allow_upgrade_default',
    section: 'LLM',
    label: 'Allow LLM upgrade by default',
    type: 'boolean',
    default: false,
    description:
      'When true, recipes without an explicit allow_llm_upgrade variable still accept an upgrade to a higher-tier LLM when no exact-tier match is available.',
  },
  {
    key: 'llm.free_pool_strategy',
    section: 'LLM',
    label: 'Free-pool coordination strategy',
    type: 'enum',
    default: 'round_robin',
    enum: ['round_robin', 'weighted'] as const,
    description:
      'How the resolver picks among tied free-pool entries. round_robin rotates a cursor across calls; weighted samples by entry weight.',
  },
  {
    key: 'llm.budget',
    section: 'LLM',
    label: 'Daily token budget',
    type: 'number',
    default: 0,
    min: 0,
    description:
      'Maximum tokens the server will spend across BYOK slots per day. 0 = unlimited. Free-pool entries have their own per-entry daily_cap_tokens caps and are not counted here.',
  },

  // ─── Storage + quotas ────────────────────────────────────────
  {
    key: 'vault.quota.per_publisher_bytes',
    section: 'Vault',
    label: 'Per-publisher vault quota (bytes)',
    type: 'number',
    default: 1 * 1024 * 1024, // 1 MB
    min: 0,
    description:
      'Per-publisher cap on vault storage, summed across that publisher\'s keys. Takes effect on server restart.',
  },
  {
    key: 'vault.quota.total_bytes',
    section: 'Vault',
    label: 'Total vault quota (bytes)',
    type: 'number',
    default: 50 * 1024 * 1024, // 50 MB
    min: 0,
    description:
      'Absolute cap on all vault storage across every publisher. Takes effect on server restart.',
  },
  {
    key: 'data.shared.quota.bytes',
    section: 'Shared data',
    label: 'Durable shared-data quota (bytes)',
    type: 'number',
    // ⛔ SERVER SCALE. Was 100 MB — an extension-era budget. `data.shared` is
    // the owner's own durable, recipe-authored data; the mirror collections
    // were already re-scaled for the server (files 5 GB, mail 2 GB) while this
    // was not, which is backwards: a collection re-syncs from its source and
    // these rows have no source to re-sync from.
    default: 5 * 1024 * 1024 * 1024, // 5 GB
    min: 0,
    description:
      'Quota for the durable data.shared.* SQLite table (+ CAS blobs). This is '
      + 'owner-authored data with no upstream to re-sync from, so it is sized '
      + 'for a server disk rather than a browser profile.',
  },
  {
    key: 'shared.max_bytes',
    section: 'Shared data',
    label: 'Memory-tier shared cap (bytes)',
    type: 'number',
    // Raised with `data.shared`, but far less: this tier is VOLATILE cache
    // (LRU + TTL), so eviction here loses nothing durable.
    default: 500 * 1024 * 1024, // 500 MB
    min: 0,
    description: 'Memory-tier cap for shared.* volatile entries inside the cache layer.',
  },
  {
    key: 'cache.max_bytes',
    section: 'Cache',
    label: 'Total cache size (bytes)',
    type: 'number',
    default: 200 * 1024 * 1024, // 200 MB
    min: 0,
    description: 'Total cache size (engine L2 + shared memory tier) before LRU eviction.',
  },
  {
    key: 'storage.reserve_pct',
    section: 'Storage',
    label: 'Storage reserve (%)',
    type: 'number',
    default: 2,
    min: 0,
    max: 100,
    description:
      'Reserve percentage held back from each gated surface. A 10 MB absolute floor applies on top. Reserve is never counted as available for user content.',
  },

  // ─── Phase B — audit retention ────────────────────────────────
  //
  // ⛔ AUDIT IS AUDIT, MEMORY IS MEMORY — internal and external names match,
  // and this block deliberately says "Audit" everywhere.
  //
  // These keys govern `audit_entries` / `audit_activities`: the run-provenance
  // trail that ONLY the runtime appends to. They do NOT govern `user_memory`,
  // the owner's curated knowledge store behind the Data → Memory lens and
  // `memory.import` / `memory.create`, which takes no gate and is never pruned.
  //
  // ⚠ HISTORY, because the labels have moved twice and both moves were
  // defensible at the time. D-120 Phase 7 renamed every "audit log" label to
  // "Memory" — correct then, because audit WAS the memory substrate. D-198
  // (2026-07-11) split them, creating `user_memory` as a purpose-built store
  // and stating plainly that it is "NOT an `AuditEntry` extension — injecting
  // hand-authored rows would corrupt the audit authority". That split made the
  // Phase 7 rename stale in place: calling these knobs "Memory" now points the
  // owner at the wrong store. Reverted to Audit.
  {
    key: 'audit.retention_days',
    section: 'Audit',
    label: 'Audit retention (days)',
    type: 'number',
    // D-120 post-amendment — default flipped to `0` (no expiry). TOML
    // has no null type, so the wire format uses `0` as the no-expiry
    // sentinel; `bin.ts::auditRetentionConfig` collapses `0 → null`
    // before handing the value to the pruner. Semantic source of
    // truth lives at `MEMORY_RETENTION_DEFAULT_DAYS` (= `null`) in
    // `packages/contracts/src/memory.ts`.
    default: 0,
    min: 0,
    description:
      'Age cutoff for the memory retention pruner. Entries older than this are removed on the next prune tick unless classified as reserve (pressure transitions, kill-switch toggles, quota rejections). Set to 0 to disable age-based prune entirely (the default — "no expiry"); size-based reclaim still runs.',
  },
  {
    key: 'audit.quota.bytes',
    section: 'Audit',
    label: 'Audit log quota (bytes)',
    type: 'number',
    // ⛔ SERVER SCALE. Was 50 MB. D-120 graduated the audit log to
    // `data.memory.*` — a first-class read-only warehouse surface with
    // provenance links — but its budget stayed at the extension-era figure.
    //
    // ⚠ SCOPE: this governs `audit_entries` / `audit_activities`, the
    // machine-generated PROVENANCE TRAIL that only the runtime appends to. It
    // does NOT govern `user_memory` — the owner's own knowledge store behind
    // the Data → Memory lens and `memory.import` / `memory.create` — which
    // takes no gate and is never pruned.
    //
    // ⚠ THIS IS THE ONE SURFACE HERE THAT EVICTS RATHER THAN REJECTS.
    // Age-based prune is OFF by default (`audit.retention_days: 0`), so the
    // SIZE pass is the only live policy and it deletes OLDEST-FIRST. At 50 MB a
    // working server reached that routinely, discarding the oldest provenance
    // as ordinary housekeeping. Raising the ceiling does not change the
    // semantics — it makes eviction a genuine last resort rather than a weekly
    // event.
    default: 5 * 1024 * 1024 * 1024, // 5 GB
    min: 1 * 1024 * 1024,
    description:
      'Byte ceiling for the audit surface. Reserve rows (pressure-transition, kill-switch, quota-exceeded, audit-retention-prune, account-mismatch-rejected) are admitted up to the full quota; user-class entries stop at quota - reserve.',
  },
  {
    key: 'audit.prune_at_pct',
    section: 'Audit',
    label: 'Audit size-prune threshold (%)',
    type: 'number',
    default: 70,
    min: 10,
    max: 99,
    description:
      'Size-based prune fires once post-age usage crosses this percentage of audit.quota.bytes. Size prune walks oldest-first up to audit.prune_max_rows_per_run but never evicts reserve rows below the reserve floor.',
  },
  {
    key: 'audit.prune_interval_s',
    section: 'Audit',
    label: 'Audit pruner interval (seconds)',
    type: 'number',
    default: 3600,
    min: 60,
    description:
      'Cron cadence for the audit retention pruner. The cascade also triggers it inline when audit pressure fires, so this interval is a floor, not a deadline.',
  },
  {
    key: 'audit.prune_max_rows_per_run',
    section: 'Audit',
    label: 'Audit prune row cap per run',
    type: 'number',
    default: 1000,
    min: 1,
    description:
      'Maximum rows the size-based pass removes per invocation. Keeps each tick short so the cron + cascade-triggered passes never hold the event loop.',
  },
  {
    key: 'audit.reserve_pct',
    section: 'Audit',
    label: 'Audit reserve (%)',
    type: 'number',
    default: 4,
    min: 0,
    max: 100,
    description:
      'Reserve percentage for the audit surface — typically double storage.reserve_pct so pressure-transition + kill-switch rows always land even when user-class audit writes are blocked.',
  },

  // ─── Phase B — account / schedules quotas ─────────────────────
  {
    key: 'account.quota.bytes',
    section: 'Account',
    label: 'Account-store quota (bytes)',
    type: 'number',
    default: 10 * 1024 * 1024,
    min: 1 * 1024 * 1024,
    description:
      'Byte ceiling for the server-side account_store (OAuth refresh tokens, service-identity rows). Small by design; the extension is the cloud-sync authority, the server is a pair mirror.',
  },
  {
    key: 'scheduler.quota.bytes',
    section: 'Scheduler',
    label: 'Schedules quota (bytes)',
    type: 'number',
    default: 5 * 1024 * 1024,
    min: 256 * 1024,
    description:
      'Byte ceiling for the schedules table. Low because schedules are tiny JSON rows; a blown-out quota here implies a compromised ext mass-creating schedules.',
  },

  // ─── Phase B — cascade tuning ────────────────────────────────
  {
    key: 'cascade.debounce_window_s',
    section: 'Cascade',
    label: 'Cascade debounce window (seconds)',
    type: 'number',
    default: 60,
    min: 5,
    description:
      'Minimum cooldown between eviction-cascade passes on the same surface, bypassed when the caller passes force: true or when usage has grown > 10% since the last attempt.',
  },
  {
    key: 'cascade.orphan_scan_max_blobs',
    section: 'Cascade',
    label: 'Cascade orphan-scan row cap',
    type: 'number',
    default: 1000,
    min: 100,
    description:
      'Maximum CAS blobs examined by a single orphan-sweep pass. Keeps the sweep short so the cascade never blocks the event loop > ~200ms.',
  },

  // ─── Logging ─────────────────────────────────────────────────
  {
    key: 'log.level',
    section: 'Logging',
    label: 'Log level',
    type: 'enum',
    default: 'info',
    enum: ['debug', 'info', 'warn', 'error'] as const,
    description: 'Minimum level written to the persistent log. debug stays ring-buffer-only by default.',
  },
  {
    key: 'log.max_bytes',
    section: 'Logging',
    label: 'Max log file size (bytes)',
    type: 'number',
    default: 100 * 1024 * 1024, // 100 MB
    min: 1024 * 1024,
    description: 'Per-file size ceiling before rotation.',
  },
  {
    key: 'log.rotate_at_pct',
    section: 'Logging',
    label: 'Log rotation threshold (%)',
    type: 'number',
    default: 75,
    min: 10,
    max: 99,
    description: 'Rotate the log file once it reaches this percent of log.max_bytes.',
  },
  {
    key: 'log.debounce_window_s',
    section: 'Logging',
    label: 'Log debounce window (seconds)',
    type: 'number',
    default: 60,
    min: 1,
    description: 'Rolling window (seconds) used to coalesce identical log entries into a single fingerprint + count.',
  },
  {
    key: 'log.max_fingerprints',
    section: 'Logging',
    label: 'Log fingerprint map size',
    type: 'number',
    default: 1000,
    min: 1,
    description: 'Fingerprint map capacity; LRU-evicts (and flushes) the least-recent entries when exceeded.',
  },

  // ─── Network ─────────────────────────────────────────────────
  {
    key: 'public_port',
    section: 'Network',
    label: 'Public TLS port',
    type: 'number',
    default: 443,
    min: 1,
    max: 65535,
    integer: true,
    description:
      'Port used by the public TLS listener. Defaults to 443.',
  },
  {
    // The LAN listener's bind address. Auto-detection refuses to guess on a
    // multi-homed host (a Docker bridge or VM bridge alongside the real LAN
    // is `ambiguous_lan_candidates`) and binds loopback, which is safe but
    // makes the server unreachable from other devices — this is the way out.
    // Verified against the host's own interfaces at boot: an address this
    // machine cannot bind is ignored with a warning rather than obeyed,
    // because a failed LAN bind exits the process and this setting is only
    // reachable through the server it would stop.
    key: 'network.lan_bind_address',
    section: 'Network',
    label: 'LAN bind address',
    type: 'string',
    default: '',
    description:
      'IP address the LAN listener binds to. Leave empty to auto-detect (the default): the server follows your default route to pick an interface and binds 0.0.0.0, so it answers on both 127.0.0.1 and your network address, and falls back to 127.0.0.1 alone when it cannot tell which interface is the real one. Set an address to bind exactly that — e.g. 192.168.1.121 for one network, or 127.0.0.1 to serve only this machine. Takes effect on restart. An address this machine does not have is ignored, with the reason logged at boot.',
  },
  {
    // R26.2 Delta 2 — what the public listener serves at the bare root
    // `GET /`. Resolved per-request by the root handler (hot, no restart).
    // The setter is cross-validated against the live exposure resolution
    // via `exposure.set_apex`; this schema entry is the persistence +
    // default. Edit it through the Exposure panel, not the generic schema
    // page, so the consistency gate applies.
    key: 'network.apex_mode',
    section: 'Network',
    label: 'Root (/) serving mode',
    type: 'enum',
    default: 'redirect',
    enum: ['redirect', 'serve_webclient', 'serve_reception', 'not_found'] as const,
    // Owned by `exposure.set_apex` (which cross-validates against the live
    // exposure resolution) — NOT writable through the generic
    // `server.setConfigField`, so the consistency gate can't be bypassed.
    internal: true,
    description:
      'What the public listener serves at the bare root URL. "redirect" sends <handle>.recued.cloud visitors to app.recued.com (default); "serve_reception" serves the visitor-intake page; "serve_webclient" serves the embedded webclient; "not_found" closes the root with a 404.',
  },

  // ─── Scheduler ───────────────────────────────────────────────
  {
    key: 'scheduler.min_interval_minutes',
    section: 'Scheduler',
    label: 'Minimum cron interval (minutes)',
    type: 'number',
    default: 5,
    min: 1,
    description: 'Minimum cron interval (in minutes) accepted by the scheduler. Self-hosters can lower it.',
  },

  // ─── Recipes ─────────────────────────────────────────────────
  {
    key: 'recipe.default_timeout_seconds',
    section: 'Recipes',
    label: 'Default recipe timeout (seconds)',
    type: 'number',
    default: 600, // 10 min
    min: 1,
    description: 'Per-recipe hard timeout default. Recipes may declare their own, bounded by this.',
  },
  {
    // D-157 N.8 / D-158 O-5 — the optional staleness guard for paused
    // preflight approvals. Deliberately generous + days-scale: this is
    // product policy against an approval clicked months later firing
    // into a changed world, NOT a technical timeout (an answered ask is
    // never expired regardless of age). `0` disables the guard; the
    // composer collapses `0 → null` (mirrors `audit.retention_days`).
    key: 'preflight.stale_after_days',
    section: 'Recipes',
    label: 'Pending-approval staleness window (days)',
    type: 'number',
    default: 30,
    min: 0,
    description: 'Days a paused run may wait for preflight approval before the staleness guard expires it (the prompt is withdrawn and the run fails with "approval was not granted in time"). An approval the user already gave is never expired. Set to 0 to keep paused runs waiting forever. This governs the DECISION only — the public /ask link is separately capped at 48h by a fixed constant (ASK_LANDING_LINK_TTL_MS), so 0 does not leave a forwardable bearer URL alive forever.',
  },

  // ─── Tier ────────────────────────────────────────────────────
  {
    key: 'tier.grace_period_hours',
    section: 'Tier',
    label: 'Tier grace period (hours)',
    type: 'number',
    default: 72,
    min: 0,
    description: 'Grace period after entitlement expiry during which Pro features keep working before degrading to free.',
  },

  // ─── Lifecycle + supervisor (D-105 Phase C) ──────────────────
  {
    key: 'supervisor.mode',
    section: 'Lifecycle',
    label: 'Supervisor mode',
    type: 'enum',
    default: 'auto',
    enum: ['auto', 'native', 'systemd', 'launchd', 'docker', 'dev'] as const,
    description:
      'Process supervisor type. "auto" detects from env signatures (INVOCATION_ID, XPC_SERVICE_NAME, /.dockerenv, RECUED_LAUNCHER). Change takes effect on restart.',
  },
  {
    key: 'lifecycle.drain_timeout_s',
    section: 'Lifecycle',
    label: 'Drain timeout (seconds)',
    type: 'number',
    default: 30,
    min: 5,
    max: 600,
    description:
      'Wall-clock budget for a graceful drain (SIGTERM / requestShutdown / requestRestart). Each drain step has its own sub-timeout bounded by this.',
  },
  {
    key: 'lifecycle.crash_loop_window_s',
    section: 'Lifecycle',
    label: 'Crash-loop window (seconds)',
    type: 'number',
    default: 60,
    min: 10,
    description:
      'Rolling window within which repeated unclean exits count toward crash-loop detection.',
  },
  {
    key: 'lifecycle.crash_loop_threshold',
    section: 'Lifecycle',
    label: 'Crash-loop threshold',
    type: 'number',
    default: 5,
    min: 2,
    description:
      'Unclean exits within the crash-loop window that trip detection. On trip, the kill switch engages with reason=crash_loop.',
  },
  {
    key: 'lifecycle.crash_loop_auto_reset_after_s',
    section: 'Lifecycle',
    label: 'Crash-loop auto-reset (seconds)',
    type: 'number',
    default: 3600,
    min: 60,
    description:
      'Sustained uptime that automatically clears crash-loop counters. Prevents stale crashes from contributing to today\'s window.',
  },
  {
    key: 'lifecycle.watch_config',
    section: 'Lifecycle',
    label: 'Watch config.toml for changes',
    type: 'boolean',
    default: false,
    description:
      'When true, fs.watch triggers a reload on file edits (500ms debounce). SIGHUP remains the durable path — fs.watch double-fires on macOS and is unreliable on network filesystems.',
  },
  {
    key: 'lifecycle.lock_file',
    section: 'Lifecycle',
    label: 'Instance lock file path',
    type: 'string',
    default: '',
    description:
      'Override the in-process lock file location. Empty string uses {data_path}/recued-server.lock.',
  },

  // ─── Phase D — collection defaults (D-106) ────────────────────
  {
    key: 'collection.mail.default.quota_bytes',
    section: 'Collections',
    label: 'Mail collection quota default (bytes)',
    type: 'number',
    default: 2 * 1024 * 1024 * 1024, // 2 GB
    min: 16 * 1024 * 1024,
    description:
      'Per-mail-account default quota. DB-backed instances can override via their `quota_bytes` config field; this runtime key seeds the gate when the instance omits it.',
  },
  {
    key: 'collection.mail.default.retention_days',
    section: 'Collections',
    label: 'Mail collection retention default (days)',
    type: 'number',
    default: 365,
    min: 0,
    description:
      'Age-based retention window for mail collections. Overridable per-account via the instance config `retention_days` field. Zero disables the pruner (records kept indefinitely).',
  },
  {
    key: 'collection.file.default.quota_bytes',
    section: 'Collections',
    label: 'File collection quota default (bytes)',
    type: 'number',
    default: 5 * 1024 * 1024 * 1024, // 5 GB
    min: 16 * 1024 * 1024,
    description:
      'Per-file-root default quota. File collections never auto-evict (user owns the filesystem); hitting the quota rejects writes with STORAGE_PRESSURE instead.',
  },
  {
    key: 'collection.file.default.retention_days',
    section: 'Collections',
    label: 'File collection retention default (days)',
    type: 'number',
    default: 0,
    min: 0,
    description:
      'Retention disabled by default for file collections — the user owns the filesystem, so we never auto-delete records of files they still have on disk.',
  },
  {
    key: 'collection.webhook.default.quota_bytes',
    section: 'Collections',
    label: 'Webhook collection quota default (bytes)',
    type: 'number',
    default: 200 * 1024 * 1024, // 200 MB
    min: 4 * 1024 * 1024,
    description:
      'Per-endpoint default quota. Webhook payloads are short-lived by design; keep the ceiling small to force retention rather than indefinite accumulation.',
  },
  {
    key: 'collection.webhook.default.retention_days',
    section: 'Collections',
    label: 'Webhook collection retention default (days)',
    type: 'number',
    default: 30,
    min: 0,
    description:
      'Age-based retention window for webhook collections. 30 d matches the notifications-in-flight posture; payloads older than this get pruned automatically.',
  },
  {
    key: 'collection.webhook.max_body_bytes',
    section: 'Collections',
    label: 'Webhook inbound body ceiling (bytes)',
    type: 'number',
    default: 1024 * 1024, // 1 MB
    min: 1024,
    description:
      'Hard cap on inbound webhook body size. Requests above this get 413 before persistence. Per-endpoint `max_body_bytes` can be lower — the listener applies the tighter of the two.',
  },
  {
    key: 'collection.sync.max_inflight_per_adapter',
    section: 'Collections',
    label: 'Max concurrent fetches per adapter',
    type: 'number',
    default: 4,
    min: 1,
    description:
      'Concurrency ceiling for per-collection sync loops. Gmail/Graph paginated fetches honor this cap; IMAP fetches are serialised per folder regardless. Raising it trades latency for provider rate-limit headroom.',
  },
  {
    key: 'collection.retention_prune_interval_s',
    section: 'Collections',
    label: 'Collection retention cron interval (seconds)',
    type: 'number',
    default: 3600,
    min: 60,
    description:
      'Cron cadence for per-collection age-based retention. The eviction cascade also triggers retention inline on pressure, so this interval is a floor for the steady-state pass.',
  },
  {
    key: 'collection.mail.gmail.poll_seconds',
    section: 'Collections',
    label: 'Gmail history poll cadence (seconds)',
    type: 'number',
    default: 30,
    min: 5,
    description:
      'Poll interval for Gmail historyId watermark advance. Gmail free-tier quota is generous enough that 30 s is safe for personal mailboxes; raise for rate-limited accounts, lower for busy shared mailboxes.',
  },
  {
    key: 'collection.mail.graph.poll_seconds',
    section: 'Collections',
    label: 'Graph delta poll cadence (seconds)',
    type: 'number',
    default: 30,
    min: 5,
    description:
      'Poll interval for Microsoft Graph deltaLink. Same rationale as the Gmail knob above — the default is safe for personal accounts on the /common tenant.',
  },
  {
    key: 'collection.webhook.public_reachable',
    section: 'Collections',
    label: 'Webhook public_reachable gate',
    type: 'boolean',
    default: false,
    description:
      'Gate for the inbound webhook listener. Only accept requests when the operator has confirmed this server is reachable from the open internet (public host or user-hosted tunnel). D-096: Pro cloud never relays webhooks — flipping this is self-host acknowledgement.',
  },

  // ─── D-117 — calendar collection defaults ─────────────────────
  {
    key: 'collection.calendar.default.quota_bytes',
    section: 'Collections',
    label: 'Calendar collection quota default (bytes)',
    type: 'number',
    default: 512 * 1024 * 1024, // 512 MB
    min: 8 * 1024 * 1024,
    description:
      'Per-calendar-account default quota. Calendar payloads are tiny so 512 MB covers years of warehouse history; raise only if you keep an unusually long retention window.',
  },
  {
    key: 'collection.calendar.default.retention_days',
    section: 'Collections',
    label: 'Calendar collection retention default (days)',
    type: 'number',
    default: 365,
    min: 0,
    description:
      'Age-based retention window for calendar collections. Overridable per-instance via the instance config `retention_days` field. Zero disables the pruner (events kept indefinitely).',
  },
  {
    key: 'collection.calendar.default.expansion_future_days',
    section: 'Collections',
    label: 'Calendar expansion window (forward, days)',
    type: 'number',
    default: 90,
    min: 1,
    description:
      'How many days ahead the warehouse expands recurring events to. Smaller = less storage; larger = recipes can plan further out. Per-instance override via the instance config `expansion_future_days` field.',
  },
  {
    key: 'collection.calendar.default.expansion_past_days',
    section: 'Collections',
    label: 'Calendar expansion window (backward, days)',
    type: 'number',
    default: 30,
    min: 0,
    description:
      'How many days back the warehouse keeps expanded events. The retention pruner additionally drops events older than `retention_days` regardless of expansion window.',
  },
  {
    key: 'collection.calendar.gcal.poll_seconds',
    section: 'Collections',
    label: 'gcal poll cadence (seconds)',
    type: 'number',
    default: 300,
    min: 30,
    description:
      'Poll interval for the Google Calendar `events.list` syncToken loop. 300 s is calendar-appropriate (low churn); raise on rate-limited accounts.',
  },
  {
    key: 'collection.calendar.graph.poll_seconds',
    section: 'Collections',
    label: 'graph (calendar) poll cadence (seconds)',
    type: 'number',
    default: 300,
    min: 30,
    description:
      'Poll interval for Microsoft Graph `/me/calendarView/delta`. Same rationale as the gcal knob; the same Graph OAuth grant covers mail + calendar so be mindful when both are enrolled.',
  },
  {
    key: 'collection.calendar.caldav.poll_seconds',
    section: 'Collections',
    label: 'caldav poll cadence (seconds)',
    type: 'number',
    default: 300,
    min: 30,
    description:
      'Poll interval for the CalDAV `REPORT calendar-query` ETag-diff loop. iCloud / Fastmail / Nextcloud all tolerate 300 s comfortably.',
  },

  // ─── D-148 — Recued cloud endpoint (Pro-only API host) ────────
  {
    key: 'cloud.base_url',
    section: 'Cloud',
    label: 'Recued cloud API base URL',
    type: 'string',
    // Per the two-TLD domain policy: Pro-only cloud-Worker endpoints
    // (DDNS / ACME / sync) live on `api.recued.com`; the public TLD
    // `recued.com` serves marketing + marketplace + the webclient PWA +
    // free-tier endpoints (reachability probe, pair-blob relay,
    // marketplace API). Production override is unnecessary; staging /
    // dev override points at `api.recued2.com` (the second environment) or
    // a mirror deployment's own API host.
    //
    // ⛔ There is NO env override. `RECUED_RUNTIME_*` was removed 2026-07-28
    // (see `env.ts`), so `RECUED_RUNTIME_CLOUD_BASE_URL` — which this comment
    // used to name — is DEAD and silently does nothing. Set this TOML key (or
    // point `RECUED_CONFIG` at a file that does). Getting this wrong is
    // invisible: the server falls back to the production default, its
    // entitlement mint then fails against the wrong Worker, and the
    // Pro-provisioning tick skips SILENTLY (`entitlement_unavailable` is not
    // logged) — no reserve, no DDNS, no error. Cost a live-drive session
    // 2026-08-05.
    //
    // ⛔⛔ AND THE DEFAULT ITSELF WAS THE WRONG WORKER UNTIL 2026-08-26. It read
    // `https://api.recued.cloud`, which has NEVER existed — NXDOMAIN, no record
    // ever published. wrangler.sync.toml deploys the `recued-cloud` worker to
    // `api.recued.com` (and `api.recued2.com` for the second environment), and
    // the live-drive scripts plus compose-listeners.ts already hardcoded the
    // right host, so the config default was the only copy still wrong.
    //
    // 🔑 The warning above described this exact failure — silent skip, no
    // reserve, no DDNS, no error — and sat directly on top of the value that
    // caused it. A comment explaining how a setting fails is not a substitute
    // for the setting being right, and its presence made the line look reviewed.
    default: 'https://api.recued.com',
    description:
      'Base URL for the Recued cloud API. Production is https://api.recued.com — the Pro-only endpoint family (DDNS update, ACME issue-cert, account sync). Override for staging / dev / test environments. Trailing slashes are stripped by each adapter.',
  },

  // ─── D-118 — service collection defaults ──────────────────────
  {
    key: 'collection.service.default.quota_bytes',
    section: 'Collections',
    label: 'Service collection quota default (bytes)',
    type: 'number',
    default: 5 * 1024 * 1024 * 1024, // 5 GB
    min: 16 * 1024 * 1024,
    description:
      'Per-service default quota — bytes consumed by `<data_path>/services/<slug>/`. Per-instance overrides via the instance config `quota_bytes` field. Hitting the quota rejects invokes with SERVICE_STORAGE_PRESSURE; we never auto-evict (user content lives there).',
  },
  {
    key: 'collection.service.min_disk_free_bytes',
    section: 'Collections',
    label: 'Service OS free-space floor (bytes)',
    type: 'number',
    default: 1 * 1024 * 1024 * 1024, // 1 GB
    min: 128 * 1024 * 1024,
    description:
      'Floor on `statfs(data_path).bavail` checked per service-invoke. When OS free-space drops below this, every invoke gets SERVICE_STORAGE_PRESSURE regardless of per-instance quota — protects the rest of the machine from a service exhausting the disk.',
  },
  {
    key: 'collection.service.invoke_slack_bytes',
    section: 'Collections',
    label: 'Service per-invoke slack (bytes)',
    type: 'number',
    default: 100 * 1024 * 1024, // 100 MB
    min: 1 * 1024 * 1024,
    description:
      'Headroom above the cached per-instance du sample, allowed before refusing the invoke. Covers binaries that write a few hundred MB inside one op without forcing a synchronous du sample on the hot path.',
  },
  {
    key: 'collection.service.du_sample_interval_s',
    section: 'Collections',
    label: 'Service du sample interval (seconds)',
    type: 'number',
    default: 30,
    min: 5,
    description:
      'How often the service quota tracker refreshes its cached `du` sample over each enrolled instance cwd. 30 s is cheap on personal-server scale; lower on busy servers, raise to reduce I/O.',
  },
  // ─── D-179 P5 — invoke guard knobs (spec § 5: knobs, not designs) ──
  {
    key: 'collection.service.invoke_timeout_ceiling_ms',
    section: 'Collections',
    label: 'Service invoke timeout ceiling (ms)',
    type: 'number',
    default: 600_000, // 10 min — the ffmpeg template precedent
    min: 1_000,
    description:
      'Server-level ceiling on any invoke op\'s authored `timeout_ms` — the effective deadline is min(authored, ceiling), SIGKILL on expiry. Hours-long work belongs in user-space detached jobs (D-179 § 5), not a long invoke; raise this only if a trusted template genuinely needs a longer blocking call.',
  },
  {
    key: 'collection.service.max_concurrent_invokes',
    section: 'Collections',
    label: 'Service max concurrent invokes (global)',
    type: 'number',
    default: 16,
    min: 1,
    description:
      'Server-wide bound on simultaneously running service invokes. Exceeding it rejects the invoke with SERVICE_INVOKE_CONCURRENCY (no queueing — re-run beats resume). Protects the host from a fan-out (e.g. a 10-dish group firing at once) forking unbounded processes.',
  },
  {
    key: 'collection.service.max_concurrent_invokes_per_instance',
    section: 'Collections',
    label: 'Service max concurrent invokes (per instance)',
    type: 'number',
    default: 4,
    min: 1,
    description:
      'Per-service-instance bound on simultaneously running invokes, under the global bound. Kickoff wrappers detach in seconds, so parallel dish fires rarely hold more than a couple of slots; a binary that serializes badly (one big scratch dir) can be pinned to 1 here.',
  },
] as const satisfies readonly ScalarSchemaEntry[];

export type RuntimeKey = typeof RUNTIME_SCHEMA[number]['key'];

export const RUNTIME_SCHEMA_MAP: Record<string, ScalarSchemaEntry> =
  Object.fromEntries(RUNTIME_SCHEMA.map((e) => [e.key, e as ScalarSchemaEntry]));

export const getRuntimeSchemaEntry = (key: string): ScalarSchemaEntry | undefined =>
  Object.prototype.hasOwnProperty.call(RUNTIME_SCHEMA_MAP, key)
    ? RUNTIME_SCHEMA_MAP[key]
    : undefined;

/** Default values for every runtime key, derived from the schema. */
export const runtimeDefaults = (): Record<string, ScalarSchemaEntry['default']> => {
  const out: Record<string, ScalarSchemaEntry['default']> = {};
  for (const entry of RUNTIME_SCHEMA) out[entry.key] = entry.default;
  return out;
};
