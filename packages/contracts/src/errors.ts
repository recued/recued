export type ErrorSeverity = 'fatal' | 'error' | 'warn';

export type RecipeErrorCode =
  // Recipe lifecycle
  | 'RECIPE_NOT_FOUND'
  | 'RECIPE_VALIDATION_FAILED'
  | 'RECIPE_GUARD_TRIGGERED'
  | 'RECIPE_FAIL_ON_TRIGGERED'
  | 'RECIPE_PREREQUISITE_NOT_MET'
  | 'RECIPE_APPROVAL_TIMEOUT'
  /** D-234 § 234.4n — a run held on a peer's answer was abandoned because the
   *  DISH THAT OWNS IT NO LONGER EXISTS. The owner deleted it, or it went with an
   *  uninstall; either way nothing will ever resume this run, and leaving it
   *  `awaiting_peer` forever is how held runs accumulate.
   *
   *  ⚠ The run is NOT resumed — a deleted dish must not go on doing work. The
   *  hold is retired terminal and the recipe's remaining steps never execute.
   *
   *  ⛔ THE PEER IS NOT TOLD BY THIS CODE, and the notice that does tell them is a
   *  COURTESY, not a recall: a peer ask is a letter, and once sent it cannot be
   *  unsent. Their answer, if it comes, is refused as unsolicited — honest,
   *  because by then it is. */
  | 'RECIPE_HOLD_ABANDONED'
  | 'RECIPE_APPROVAL_DENIED'
  | 'RECIPE_BUDGET_EXCEEDED'
  /** D-157 P1 slice 3 — resume from a preflight checkpoint failed because
   *  the recipe doesn't contain a step matching the checkpoint's
   *  `gated_step_id`. The recipe drifted between pause and resume — the
   *  author rebuilt the recipe, or the wrong checkpoint was paired with
   *  this run. Fatal: the run cannot be resumed; the user re-runs from
   *  scratch (or aborts via the gateway's `Deny` path). */
  | 'CHECKPOINT_STEP_NOT_FOUND'
  /** D-157 P1 slice 4 — the preflight gate fired but no `CheckpointStore`
   *  is wired on the host. The pause cannot be made durable; the run
   *  downgrades to terminal failure rather than write an
   *  `awaiting_approval` anchor without a `checkpoint_id` (codex BLOCKER
   *  fold — the anchor invariant requires the link). The user re-runs
   *  from scratch after the deployment wires durable storage. */
  | 'CHECKPOINT_STORE_UNAVAILABLE'
  /** D-157 P1 slice 4 — the preflight gate fired and the host attempted
   *  to persist the `Checkpoint`, but the store write threw. Same
   *  posture as `CHECKPOINT_STORE_UNAVAILABLE` — the pause cannot be
   *  made durable, so the run downgrades to terminal failure. */
  | 'CHECKPOINT_WRITE_FAILED'
  /** D-153 P2.C — the `(channel × actor)` policy matrix gate refused
   *  this recipe pre-dispatch. The Engine never invoked the engine /
   *  executor — no external side-effect happened. The error's
   *  `details` carries the denial list (which steps + which deny codes)
   *  so the user can locate the offending step in their recipe
   *  authoring UI. */
  | 'RECIPE_POLICY_DENIED'
  // Ingredient
  | 'INGREDIENT_NOT_FOUND'
  | 'INGREDIENT_VERSION_MISMATCH'
  | 'INGREDIENT_SCOPE_INSUFFICIENT'
  | 'INGREDIENT_ENDPOINT_BLOCKED'
  | 'INGREDIENT_OUTPUT_VALIDATION_FAILED'
  | 'INGREDIENT_ADAPTER_ALL_FAILED'
  // Connection / OAuth
  | 'CONNECTION_NOT_BOUND'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_AUTH_EXPIRED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'VAULT_KEY_MISSING'
  | 'VAULT_CROSS_PUBLISHER'
  | 'OAUTH_EXPIRED'
  | 'OAUTH_REVOKED'
  | 'TOKEN_REFRESH_FAILED'
  // D-125 P4.2 — connection.mcp handler
  /** Recipe step referenced an MCP tool name that isn't in the
   *  connection record's cached tool list (populated at probe time).
   *  Either the server removed the tool or the recipe was authored
   *  against a different MCP instance. Re-probe the connection to
   *  refresh the cache, or fix the recipe. */
  | 'MCP_TOOL_NOT_FOUND'
  /** D-232 § 21 — an MCP tool that WAS REACHED and reported a failure: a
   *  JSON-RPC error envelope, or a `tools/call` result carrying `isError: true`.
   *
   *  ⛔⛔ ITS WHOLE JOB IS TO NOT BE `NETWORK_ERROR`. Both outcomes used to land
   *  on that code — a transport failure because it genuinely is one, and a tool
   *  error because the gateway threw a bare `Error` and the step runner
   *  DEFAULTED there. So "nobody answered" and "they answered and refused you"
   *  were indistinguishable downstream, and § 21 could not tell `unavailable`
   *  (come back later) from `error` (a human must look). Retrying the second
   *  forever is the failure mode that costs something.
   *
   *  🔑 THE PEER WAS REACHED. That is the entire semantic content, and it is
   *  what makes `NETWORK_ERROR` honest again for the case it names. */
  | 'MCP_TOOL_ERROR'
  // D-177 P2b — connection-adapter classification gate
  /** A `connection-mcp-read` / `connection-mcp-write` dispatch named a
   *  tool the user has not enabled and classified for this connection
   *  (Settings → Connections → Tools), or the classification doesn't
   *  fit the dispatch tier (a read-tier dispatch of a write-classified
   *  tool). Fail-closed: the manifest tier carries the classification
   *  into the policy verdict, so a mismatch would be a tier spoof. */
  | 'MCP_TOOL_NOT_CLASSIFIED'
  /** MCP transport selected on the connection record (`websocket` /
   *  `stdio`) is not yet wired in this runtime. P4.2 ships sse-as-HTTP
   *  POST as the unified transport; long-lived ws + child-process
   *  transports land in a follow-on. */
  | 'MCP_TRANSPORT_NOT_IMPLEMENTED'
  // D-125 P4.3 — connection.notification handler
  /** Notification subtype on the connection record (`email` today)
   *  is not yet wired in this runtime. P4.3 ships slack / telegram /
   *  in-app; SMTP for email lands in a follow-on (the SMTP state
   *  machine — EHLO / STARTTLS / AUTH / DATA / QUIT — is substantial
   *  enough to warrant its own sub-phase). */
  | 'NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED'
  /** Vendor-side delivery failure surfaced by a notification provider
   *  whose HTTP call succeeded but whose envelope reported the send
   *  itself didn't go through (`ok: false` from Slack, `ok: false`
   *  from Telegram). Distinct from `NETWORK_ERROR` (HTTP-level) and
   *  `OAUTH_EXPIRED` (auth-level) because the recipe / wrapper may
   *  want to branch on it differently — e.g. retry on 4xx-equivalent
   *  vendor errors, surface a specific message on rate-limit-equivalent
   *  shapes. The message tail carries the vendor's `error` string. */
  | 'NOTIFICATION_SEND_FAILED'
  // Network / API
  | 'NETWORK_ERROR'
  | 'API_RATE_LIMITED'
  | 'API_SERVER_ERROR'
  | 'API_NOT_FOUND'
  | 'API_FORBIDDEN'
  | 'STEP_TIMEOUT'
  /** Write/admin/destructive call whose outcome could not be confirmed from
   *  the client side. The request may or may not have succeeded server-side.
   *  The client cannot distinguish "request never arrived" from "request
   *  arrived, committed, but acknowledgment was lost" without provider-side
   *  idempotency keys. The correct response is to tell the user to verify
   *  in their CRM — NEVER silently retry, as that risks duplicate writes. */
  | 'ACTION_DELIVERY_UNCERTAIN'
  // Transform
  | 'TRANSFORM_ERROR'
  | 'TRANSFORM_INVALID_INPUT'
  | 'TRANSFORM_TIMEOUT'
  | 'CONDITION_PARSE_ERROR'
  // AI
  | 'AI_LLM_UNAVAILABLE'
  /** The selected model/provider explicitly refused the requested completion
   *  (for example a normalized provider `content_filter` stop). This is not a
   *  malformed model response and must remain distinguishable from parse or
   *  schema failures so an attended workflow can offer a deterministic path. */
  | 'AI_MODEL_REFUSED'
  | 'AI_OUTPUT_INVALID'
  | 'AI_TIMEOUT'
  | 'AI_TOKEN_BUDGET_EXCEEDED'
  | 'AI_RESPONSE_PARSE_FAILED'
  | 'AI_RESPONSE_VALIDATION_FAILED'
  // DOM
  | 'DOM_SELECTOR_MISSING'
  | 'DOM_SELECTOR_NOT_FOUND'
  | 'DOM_CROSS_ORIGIN'
  | 'DOM_WRITE_FAILED'
  | 'DOM_PAGE_NOT_MATCHING'
  // Cache / Context
  | 'CACHE_MISS'
  | 'CONTEXT_SIZE_EXCEEDED'
  // Security
  | 'ATTESTATION_VIOLATION'
  /** Recipe uses browser-only ingredients (DOM, web-chat) on a runtime
   *  that can't execute them — typically the server dispatching a
   *  recipe whose steps require a live tab. Fatal for that run. */
  | 'ROLE_RESTRICTION'
  // Storage + shared namespaces (D-103 Phase A)
  /** A gated surface is in `pressure_managed` or `writes_blocked` and
   *  refused a user write. Phase B adds eviction policy on top. */
  | 'STORAGE_PRESSURE'
  /** Per-publisher or total vault quota exceeded; or data.shared.* quota
   *  exceeded. Atomic — the failed write never lands. */
  | 'QUOTA_EXCEEDED'
  /** Recipe attempted to write to a `data.*` subnamespace that is
   *  warehouse-owned (mail/file/webhook). User writes only accept the
   *  `data.shared.*` path. */
  | 'DATA_NAMESPACE_READONLY'
  /** Key mismatch — the extension's account token doesn't match the
   *  paired server's realm. Re-pair required. */
  | 'ACCOUNT_MISMATCH'
  /** Pro-gated surface used on a tier that doesn't cover it, OR a
   *  free-pool limit (daily cap, monthly cap) reached. */
  | 'TIER_LIMIT_EXCEEDED'
  /** `shared-*` ingredient received a key that doesn't pass validation
   *  (bad prefix, >512 chars, illegal chars). */
  | 'SHARED_KEY_INVALID'
  /** Ext-side kernel ingredient routed to the server for a durable
   *  `data.shared.*` write, but no paired server is reachable. */
  | 'SERVER_NOT_REACHABLE'
  /** `shared-write` value exceeds the hard 10 MB per-entry cap. */
  | 'VALUE_TOO_LARGE'
  // Lifecycle + supervisor (D-105 Phase C)
  /** Rpc rejected because the server is `draining` (restart or shutdown
   *  in progress). Lifecycle + status methods are exempt via allowlist. */
  | 'DRAINING'
  /** Rpc rejected because the server is still in `booting` state and
   *  hasn't completed its ready signal. Retry shortly. */
  | 'NOT_READY'
  /** Boot aborted — another instance already holds the lock file at
   *  `{data_path}/recued-server.lock`. The supervisor should stop
   *  retrying (exit code 4 is fatal to retry loops). */
  | 'LOCK_HELD'
  /** Crash-loop detection engaged the kill switch. User-class writes
   *  are rejected until `server.resetCrashLoop` clears it or the
   *  auto-reset window elapses. */
  | 'CRASH_LOOP_ACTIVE'
  // Warehouse collections (D-106 Phase D)
  /** Rpc targeted `(platform, slug)` didn't match a registered
   *  collection — either the platform isn't known ('mail' / 'file' /
   *  'webhook') or no adapter was registered for that slug. Usually a
   *  stale reference from a recipe that outlived its collection
   *  config. */
  | 'COLLECTION_NOT_FOUND'
  /** Adapter couldn't reach the underlying source: IMAP server down,
   *  Gmail/Graph OAuth revoked, file path deleted, etc. The gate stays
   *  readable (records already in the warehouse are fine) but new
   *  sync ticks error out. Retryable with a fresh connect. */
  | 'COLLECTION_SOURCE_UNREACHABLE'
  /** Webhook collection registration or inbound POST rejected because
   *  the server can't host the endpoint: `public_reachable=false` or
   *  `webhook_port=0`. Load-bearing per D-096 — the cloud never
   *  relays inbound webhooks, so self-host users must surface a
   *  public address or run their own tunnel. */
  | 'WEBHOOK_UNAVAILABLE'
  // Phase G (D-109)
  /** `triggers.create` / `update` rejected a `pattern` string that
   *  didn't parse as a valid `WarehouseEventBus` subscribe expression.
   *  Bad input, not retryable without user edit. */
  | 'TRIGGER_PATTERN_INVALID'
  /** Trigger dispatch targeted a `(recipe_id, publisher_id)` pair that
   *  isn't installed on this server. Dispatch skips the firing and
   *  auto-disables the trigger after the configured error cap. */
  | 'TRIGGER_RECIPE_NOT_INSTALLED'
  /** `server.archive.status` / `cancel` received a `job_id` the server
   *  doesn't know — either the job never existed or it completed and
   *  aged out of the in-memory status map. */
  | 'ARCHIVE_JOB_UNKNOWN'
  /** `server.archive.import` called while a prior import is still
   *  running. Imports are serialized per server — the caller should
   *  poll status, then retry after the in-flight one finishes. */
  | 'ARCHIVE_IMPORT_IN_PROGRESS'
  /** `collection.deleteRecord` targeted a record that doesn't exist
   *  in the named `(platform, slug)` table. Distinct from
   *  `COLLECTION_NOT_FOUND` (table absent) — here the table exists
   *  but the row does not. */
  | 'COLLECTION_RECORD_NOT_FOUND'
  // Phase 3
  /** Event-trigger binder refused an incoming event because the
   *  pending-run queue exceeded its back-pressure cap. Drops the
   *  event + audits; user must reduce producer rate or widen the
   *  recipe's filter. Load-bearing — a broken event emitter
   *  should NOT drown the runtime by queueing thousands of runs. */
  | 'EVENT_TRIGGER_BACKPRESSURE'
  // D-116 on_failure binding (install-time)
  /** Recipe's `on_failure.recipe_id` does not resolve to an installed
   *  recipe. Handler must be installed before the source references it. */
  | 'ON_FAILURE_HANDLER_UNKNOWN'
  /** Recipe's `on_failure.recipe_id` resolves but the handler has no
   *  `trigger_steps` — it isn't a reactive recipe and cannot receive
   *  recipe-watcher dispatches. */
  | 'ON_FAILURE_HANDLER_NOT_REACTIVE'
  /** Handler is reactive but none of its `trigger_steps` invoke the
   *  `recipe-watcher` ingredient — the engine has no way to wire the
   *  failure signal. */
  | 'ON_FAILURE_HANDLER_MISSING_WATCHER'
  // D-118 — data.service platform
  /** Slug not in `collection_instances` for `platform = 'service'`.
   *  Distinct from `COLLECTION_NOT_FOUND` (table absent) — here the
   *  service registry exists but the named instance does not. */
  | 'SERVICE_NOT_FOUND'
  /** `template_slug` at enroll time doesn't resolve to a known
   *  `kind: service` ingredient on this server. Stale recipe install
   *  or the user uninstalled the template. */
  | 'SERVICE_TEMPLATE_UNAVAILABLE'
  /** Template's declared `platform` doesn't match the server OS.
   *  Refused early at enroll — clear error rather than a deferred
   *  install failure. */
  | 'SERVICE_PLATFORM_MISMATCH'
  /** `install[]` is null for this template — UI should surface the
   *  `install_hint` string instead. Returned by the install rpc when
   *  invoked against a hint-only template. */
  | 'SERVICE_INSTALL_UNAVAILABLE'
  /** Installer subprocess exited non-zero. Audit row carries the
   *  full installer output; user retries via the dashboard. */
  | 'SERVICE_INSTALL_FAILED'
  /** Upgrade subprocess exited non-zero. Previous binary preserved
   *  via `.bak` (download kind) or PM-managed rollback. */
  | 'SERVICE_UPGRADE_FAILED'
  /** Uninstaller subprocess exited non-zero. Instance row may or
   *  may not have been removed depending on the failure stage. */
  | 'SERVICE_UNINSTALL_FAILED'
  /** `service-start` was called against an instance already in the
   *  `running` state. Non-error variant — the dispatcher returns the
   *  current `ServiceStatus` rather than a fault. */
  | 'SERVICE_ALREADY_RUNNING'
  /** `service-stop` or `service-invoke` (for ops requiring a live
   *  process) called when the instance is stopped. */
  | 'SERVICE_NOT_RUNNING'
  /** `consecutive_crashes` reached `SERVICE_CONSECUTIVE_CRASHES_MAX`
   *  (5). Supervisor stopped restart attempts; user must click
   *  `[Clear & retry]` to resume. */
  | 'SERVICE_PERMANENTLY_CRASHED'
  /** `service-invoke op:` not in `caps.invoke`, OR `service-start` /
   *  `service-stop` called against a tool-shaped instance with the
   *  corresponding cap set to `'no'`. */
  | 'SERVICE_OP_NOT_SUPPORTED'
  /** `lifecycle.invoke.<op>.input` validation failed — wrong type,
   *  missing required field, enum value out of range, or a flag-
   *  injection guard tripped (`file_ref` value starting with `-`). */
  | 'SERVICE_INPUT_INVALID'
  /** Two-layer storage gate failed at invoke: cached instance bytes
   *  exceed the per-instance quota, OR live `statvfs` free-space is
   *  below `SERVICE_MIN_DISK_FREE_BYTES_DEFAULT`. */
  | 'SERVICE_STORAGE_PRESSURE'
  /** D-179 P5 — the invoke would exceed the per-instance or global
   *  max-concurrent-invokes bound (`collection.service.
   *  max_concurrent_invokes[_per_instance]`). No queueing — the
   *  caller re-runs (re-run over resume). Retryable by definition. */
  | 'SERVICE_INVOKE_CONCURRENCY'
  /** `service-start` with `wait_until_healthy` exceeded the supplied
   *  `timeout_ms` before the health check passed. */
  | 'SERVICE_HEALTH_TIMEOUT'
  /** A structured check (install / startup / health) returned
   *  `passed: false`. The check `detail` rides on the error payload. */
  | 'SERVICE_CHECK_FAILED'
  /** `download` install kind: verified sha256 didn't match the
   *  declared sha256. Atomic replace aborted; previous binary (if
   *  any) preserved via `.bak`. */
  | 'SERVICE_DOWNLOAD_SHA_MISMATCH'
  // D-119 Phase 15 — execution scope (recipe + ingredient install gate)
  /** Author-declared `execution_scope` is wider than the scope derived
   *  from the manifest shape (or, for recipes, the bundled
   *  ingredients' intersection). Surfaced at manifest publish + bundle
   *  install time. Authors can narrow but never widen the derived
   *  constraint — declaring `['device', 'server']` while having a
   *  `dom.*` ingredient is the canonical case. */
  | 'EXECUTION_SCOPE_TOO_WIDE'
  /** Install gate refused this recipe because the current device's
   *  runtime role is not in the recipe's derived execution scope. The
   *  recipe is still well-formed — it just can't run here. Common
   *  cases: a `dom.*` recipe arriving at a serverless install, a
   *  `kind: service` recipe arriving at a device install. */
  | 'EXECUTION_SCOPE_INCOMPATIBLE'
  // D-126 — adapter kind unification (P2.1 + onward).
  //
  // ⛔ `KIND_NOT_YET_IMPLEMENTED` was REMOVED 2026-08-11. Every adapter slot
  // shipped with it until P2.2/P2.3 landed the real implementations, and the
  // `connection` slot kept it until D-125 P3 — which shipped, along with
  // P4.1/4.2/4.3. That left it with ZERO producers while its copy still read
  // "…has not shipped yet. Update Recued", pointing operators at an upgrade
  // that could never fix what they actually had: an unwired `connectionStore`.
  // The slot now uses the same kind-named `unsupported(...)` default as every
  // other kind (`INGREDIENT_ADAPTER_ALL_FAILED`, naming the missing wire).
  //
  // Removing a member is safe because an unknown code keeps its MACHINE-READABLE
  // half: `ExecutionCaseFlow.failure_codes` is assigned unconditionally, so a
  // pre-removal server's code still reaches the card. Only the prose gloss is
  // withheld, deliberately — a model-bound card must not gloss a token it
  // cannot read (`d-214-presentation-bench`: "says nothing when a code has no
  // static message, rather than guessing"). ⚠ That is also why `ERROR_MESSAGES`
  // must NOT gain a catch-all fallback at the render site: it would trade
  // silence for an uninterpretable sentence on the exact surface where shape
  // without meaning invites invention.
  // D-126 P4.3 — manifest validator codes (graduated from validator
  // free-form strings into the typed registry so the marketplace
  // submission gate + runtime install path can route on them).
  /** Manifest validator: required `kind` field is absent. The field
   *  is mandatory on every manifest — kernel and third-party alike. */
  | 'INGREDIENT_KIND_MISSING'
  /** Manifest validator: declared `kind` is not a member of
   *  `INGREDIENT_KINDS`. The eight-kind set is closed; expansion
   *  requires a decisions-log entry per the load-bearing rule. */
  | 'INGREDIENT_KIND_INVALID'
  /** Manifest validator: a top-level input key listed in
   *  `PER_KIND_REQUIRED_INPUT[kind]` is absent. Catches
   *  mis-classified ingredients that declare `kind: 'http'` without
   *  `url`, `kind: 'chat'` without `chat.prompt`, etc. */
  | 'INGREDIENT_KIND_MISSING_FIELD'
  /** Manifest validator: a top-level input key matches a regex in
   *  `PER_KIND_FORBIDDEN_PATTERNS[kind]`. Catches copy-paste
   *  classification errors — a `kind: 'http'` manifest carrying
   *  `chat.tab: 'gemini'` in input is almost certainly mis-classified
   *  as HTTP rather than chat. */
  | 'INGREDIENT_KIND_FIELD_FORBIDDEN'
  /** Manifest validator: `risk_tier` is not in
   *  `KIND_ALLOWED_TIERS[kind]`. Catches semantic mismatches like a
   *  `kind: 'ai'` manifest with `risk_tier: 'destructive'` (an
   *  inference call cannot be destructive — that belongs to
   *  `kind: 'mcp'` or `kind: 'connection'`). */
  | 'INGREDIENT_KIND_TIER_MISMATCH'
  // D-125 P5.1 — wrapper manifest validator codes for `kind: 'connection'`.
  /** Wrapper manifest validator: `kind: 'connection'` manifest is
   *  missing `input.connection_kind` or it isn't one of `'api' | 'mcp'
   *  | 'notification'`. Wrappers stamp the kind directly so the engine
   *  can route to the per-kind handler without recipe-side ambiguity;
   *  the kernel `connection` direct-adapter ingredient is exempt
   *  (recipes pass `connection_kind` as step input). */
  | 'CONNECTION_KIND_INVALID'
  /** Wrapper manifest validator: a top-level input key required for the
   *  declared `connection_kind` is absent. Per-kind requirements:
   *  api → `method`+`path`; mcp → `tool`; notification → `text`. The
   *  kernel `connection` ingredient is exempt — its per-kind shape
   *  arrives flat on the recipe step input rather than the manifest. */
  | 'CONNECTION_KIND_MISSING_FIELD'
  /** Wrapper manifest validator: `input.connection` doesn't carry a
   *  `{{config.<X>}}` interpolation. The picker config var is
   *  auto-derived from this interpolation; a hardcoded literal name
   *  (or any other ref shape) defeats the picker contract — every
   *  install would land on the same global connection record instead
   *  of the user's chosen one. */
  | 'CONNECTION_PICKER_INVALID'
  // D-127 P1.2 — mail-send error taxonomy.
  /** A `mail.send` rpc / `mail-send` ingredient / `mail-post` wrapper
   *  call targeted a `data.mail.<name>` instance whose enrollment
   *  doesn't grant outbound capability — gmail / graph were
   *  enrolled without the Send scope, or the imap enrollment didn't
   *  supply an SMTP block. Re-enroll the mail account with send
   *  enabled (Settings → Connections → Mail → Edit). */
  | 'MAIL_SEND_NOT_CAPABLE'
  /** Provider-side 401 / 403 on the send call. Token revoked,
   *  scopes dropped, or password rotated. Re-enroll the mail
   *  account to refresh credentials. */
  | 'MAIL_SEND_AUTH_FAILED'
  /** Provider rejected one or more recipient addresses as invalid
   *  RFC 5322 form, blocked domain, or otherwise undeliverable.
   *  Per-call decision — recipient list mistake, not a credential
   *  issue. Detail tail carries the offending addresses. */
  | 'MAIL_SEND_RECIPIENT_INVALID'
  /** Transient send failure — provider 5xx, connection reset, DNS
   *  hiccup, SMTP timeout. Retryable on next run; not a recipe
   *  configuration mistake. */
  | 'MAIL_SEND_NETWORK_FAILED'
  /** Sender mail-instance address appeared in the `to` recipient
   *  list. Sending to oneself via `to` is almost always a recipe
   *  configuration mistake (recipient field stuck on a default
   *  pointing at sender). cc/bcc-self is allowed for archival.
   *  Detail tail carries the offending address. */
  | 'MAIL_SEND_SELF_LOOP_TO'
  /** SMTP submission succeeded but the IMAP APPEND of the sent
   *  message to the user's Sent folder failed. Recipient still
   *  received the email; the user's local Sent folder is one
   *  record off until the next reconcile. Warning, not fatal. */
  | 'MAIL_SEND_APPEND_FAILED'
  /** D-172 P2 — a `mail-send` `attachments` ref could not be turned
   *  into bytes: the `data.file` record is missing, its CAS blob is
   *  gone, the ref points at a (reserved, unreadable) remote storage
   *  ref, or the file substrate isn't wired on this server. The send
   *  is refused rather than shipping a mail missing files the author
   *  asked for (D-172 I-6 — never silently drop). Recoverable: re-drop
   *  the file, or send without the missing attachment. */
  | 'MAIL_SEND_ATTACHMENT_UNRESOLVABLE'
  // D-127 P2.1 — kernel `mail-send` ingredient surface.
  /** The `sender_mail_instance` named on a `mail-send` step / `mail-
   *  post` wrapper input doesn't resolve to any registered
   *  `data.mail.<name>` instance. Recipe-author mistake (typo in
   *  the picker value) or stale config (the instance was removed).
   *  Recoverable: pick an existing instance, or re-enroll the named
   *  account from Settings → Mail. */
  | 'MAIL_INSTANCE_NOT_FOUND'
  // D-153 — Gateway dispatch-outbox (D-145 engine-wiring slice 3b.2).
  /** The commit Gateway refused a tool dispatch because its
   *  `dispatch_depth` exceeded `MAX_DISPATCH_DEPTH` — the within-process
   *  backstop against a runaway egress→ingress execution loop (D-153
   *  open question #22). No commit is written and no boundary is
   *  crossed; the recipe run halts. Not runtime-recoverable — a
   *  dispatch tree this deep signals a structural cycle in the recipe
   *  or cognition graph, not a transient fault. */
  | 'DISPATCH_DEPTH_EXCEEDED'
  // D-182 — cli executor failure classification. A `kind: 'cli'` local-binary op
  // failure, classified at the executor so the step error is coded honestly
  // instead of the catch-all NETWORK_ERROR (which read to an agent as a network
  // problem). The structured detail rides on `RecipeError.details.cli_failure`
  // (`CliFailureDetail` — reason / exit code / stderr tail / which tool).
  /** A cli op's binary wasn't found on PATH (spawn `ENOENT`). The tool may not
   *  be installed, or was removed. Actionable: install the tool, or check the
   *  server's PATH. The run-time twin of the proactive readiness "not reachable"
   *  state a pack-list probe surfaces before a run. */
  | 'CLI_TOOL_NOT_FOUND'
  /** A cli op's local binary ran and failed (exited outside its success codes),
   *  couldn't start for a non-`ENOENT` reason (`EACCES` / `EPERM` / empty argv),
   *  or hit its tight foreground timeout. The captured stderr tail + exit code
   *  ride on `details.cli_failure`. */
  | 'CLI_TOOL_FAILED'
  // D-192 Slice 6b — a work-entity CREATE whose vendor container dependency
  // (Linear `team`, an Asana `workspace`) is AMBIGUOUS: more than one option and
  // none named / stored. The create can't proceed until a human picks one; the
  // structured choice set rides on `RecipeError.details.container_pick`
  // (`ContainerPickDetail`). On the chat/MCP path `handleExecute` reads it,
  // raises the D-158 pick ask, and surfaces a terminal `container_pick_required`
  // — this code is the honest label if no notifier is wired to raise the ask.
  | 'CONTAINER_PICK_REQUIRED'
  // D-192 Slice 6c — a work-entity CREATE that DECIDED to create a named vendor
  // container that doesn't exist yet (a granted `create_op`). The plan rides on
  // `RecipeError.details.create_plan` (`CreatePlanDetail`); `handleExecute` reads
  // it, raises ONE create-plan confirm, and surfaces a terminal
  // `create_plan_required` — this code is the honest label if no notifier is wired.
  | 'CREATE_PLAN_REQUIRED';

/** Severity map — every code has exactly one severity. */
export const ERR: Record<RecipeErrorCode, ErrorSeverity> = {
  RECIPE_NOT_FOUND: 'fatal',
  RECIPE_VALIDATION_FAILED: 'fatal',
  RECIPE_GUARD_TRIGGERED: 'warn',
  RECIPE_FAIL_ON_TRIGGERED: 'error',
  RECIPE_PREREQUISITE_NOT_MET: 'error',
  RECIPE_HOLD_ABANDONED: 'error',
  RECIPE_APPROVAL_TIMEOUT: 'error',
  RECIPE_APPROVAL_DENIED: 'error',
  RECIPE_BUDGET_EXCEEDED: 'error',
  CHECKPOINT_STEP_NOT_FOUND: 'fatal',
  CHECKPOINT_STORE_UNAVAILABLE: 'fatal',
  CHECKPOINT_WRITE_FAILED: 'fatal',
  RECIPE_POLICY_DENIED: 'fatal',
  INGREDIENT_NOT_FOUND: 'fatal',
  INGREDIENT_VERSION_MISMATCH: 'error',
  INGREDIENT_SCOPE_INSUFFICIENT: 'error',
  INGREDIENT_ENDPOINT_BLOCKED: 'error',
  INGREDIENT_OUTPUT_VALIDATION_FAILED: 'error',
  INGREDIENT_ADAPTER_ALL_FAILED: 'error',
  CONNECTION_NOT_BOUND: 'error',
  CONNECTION_NOT_FOUND: 'error',
  CONNECTION_AUTH_EXPIRED: 'error',
  CONNECTION_REFUSED: 'error',
  CONNECTION_TIMEOUT: 'error',
  VAULT_KEY_MISSING: 'error',
  VAULT_CROSS_PUBLISHER: 'fatal',
  OAUTH_EXPIRED: 'error',
  OAUTH_REVOKED: 'fatal',
  TOKEN_REFRESH_FAILED: 'error',
  MCP_TOOL_NOT_FOUND: 'error',
  MCP_TOOL_ERROR: 'error',
  MCP_TOOL_NOT_CLASSIFIED: 'error',
  MCP_TRANSPORT_NOT_IMPLEMENTED: 'error',
  NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED: 'error',
  NOTIFICATION_SEND_FAILED: 'error',
  NETWORK_ERROR: 'error',
  API_RATE_LIMITED: 'warn',
  API_SERVER_ERROR: 'error',
  API_NOT_FOUND: 'error',
  API_FORBIDDEN: 'error',
  STEP_TIMEOUT: 'error',
  ACTION_DELIVERY_UNCERTAIN: 'error',
  TRANSFORM_ERROR: 'error',
  TRANSFORM_INVALID_INPUT: 'error',
  TRANSFORM_TIMEOUT: 'error',
  CONDITION_PARSE_ERROR: 'fatal',
  AI_LLM_UNAVAILABLE: 'error',
  AI_MODEL_REFUSED: 'warn',
  AI_OUTPUT_INVALID: 'warn',
  AI_TIMEOUT: 'error',
  AI_TOKEN_BUDGET_EXCEEDED: 'error',
  AI_RESPONSE_PARSE_FAILED: 'warn',
  AI_RESPONSE_VALIDATION_FAILED: 'warn',
  DOM_SELECTOR_MISSING: 'warn',
  DOM_SELECTOR_NOT_FOUND: 'warn',
  DOM_CROSS_ORIGIN: 'fatal',
  DOM_WRITE_FAILED: 'error',
  DOM_PAGE_NOT_MATCHING: 'warn',
  CACHE_MISS: 'warn',
  CONTEXT_SIZE_EXCEEDED: 'error',
  ATTESTATION_VIOLATION: 'fatal',
  ROLE_RESTRICTION: 'fatal',
  STORAGE_PRESSURE: 'error',
  QUOTA_EXCEEDED: 'error',
  DATA_NAMESPACE_READONLY: 'fatal',
  ACCOUNT_MISMATCH: 'fatal',
  TIER_LIMIT_EXCEEDED: 'error',
  SHARED_KEY_INVALID: 'fatal',
  SERVER_NOT_REACHABLE: 'error',
  VALUE_TOO_LARGE: 'error',
  DRAINING: 'warn',
  NOT_READY: 'warn',
  LOCK_HELD: 'fatal',
  CRASH_LOOP_ACTIVE: 'error',
  COLLECTION_NOT_FOUND: 'error',
  COLLECTION_SOURCE_UNREACHABLE: 'error',
  WEBHOOK_UNAVAILABLE: 'fatal',
  TRIGGER_PATTERN_INVALID: 'error',
  TRIGGER_RECIPE_NOT_INSTALLED: 'error',
  ARCHIVE_JOB_UNKNOWN: 'error',
  ARCHIVE_IMPORT_IN_PROGRESS: 'error',
  COLLECTION_RECORD_NOT_FOUND: 'error',
  EVENT_TRIGGER_BACKPRESSURE: 'warn',
  ON_FAILURE_HANDLER_UNKNOWN: 'fatal',
  ON_FAILURE_HANDLER_NOT_REACTIVE: 'fatal',
  ON_FAILURE_HANDLER_MISSING_WATCHER: 'fatal',
  // D-118 — data.service platform.
  SERVICE_NOT_FOUND: 'error',
  SERVICE_TEMPLATE_UNAVAILABLE: 'fatal',
  SERVICE_PLATFORM_MISMATCH: 'fatal',
  SERVICE_INSTALL_UNAVAILABLE: 'error',
  SERVICE_INSTALL_FAILED: 'error',
  SERVICE_UPGRADE_FAILED: 'error',
  SERVICE_UNINSTALL_FAILED: 'error',
  SERVICE_ALREADY_RUNNING: 'warn',
  SERVICE_NOT_RUNNING: 'error',
  SERVICE_PERMANENTLY_CRASHED: 'fatal',
  SERVICE_OP_NOT_SUPPORTED: 'fatal',
  SERVICE_INPUT_INVALID: 'fatal',
  SERVICE_STORAGE_PRESSURE: 'error',
  SERVICE_INVOKE_CONCURRENCY: 'error',
  SERVICE_HEALTH_TIMEOUT: 'error',
  SERVICE_CHECK_FAILED: 'error',
  SERVICE_DOWNLOAD_SHA_MISMATCH: 'fatal',
  // D-119 Phase 15 — execution scope.
  EXECUTION_SCOPE_TOO_WIDE: 'fatal',
  EXECUTION_SCOPE_INCOMPATIBLE: 'fatal',
  // D-126 P4.3 — manifest validator codes (graduated).
  INGREDIENT_KIND_MISSING: 'fatal',
  INGREDIENT_KIND_INVALID: 'fatal',
  INGREDIENT_KIND_MISSING_FIELD: 'fatal',
  INGREDIENT_KIND_FIELD_FORBIDDEN: 'fatal',
  INGREDIENT_KIND_TIER_MISMATCH: 'fatal',
  // D-125 P5.1 — wrapper manifest validator codes for `kind: 'connection'`.
  CONNECTION_KIND_INVALID: 'fatal',
  CONNECTION_KIND_MISSING_FIELD: 'fatal',
  CONNECTION_PICKER_INVALID: 'fatal',
  // D-127 P1.2 — mail-send error taxonomy.
  MAIL_SEND_NOT_CAPABLE: 'error',
  MAIL_SEND_AUTH_FAILED: 'error',
  MAIL_SEND_RECIPIENT_INVALID: 'error',
  MAIL_SEND_NETWORK_FAILED: 'error',
  MAIL_SEND_SELF_LOOP_TO: 'error',
  MAIL_SEND_APPEND_FAILED: 'warn',
  // D-172 P2 — attachments-v2.
  MAIL_SEND_ATTACHMENT_UNRESOLVABLE: 'error',
  // D-127 P2.1 — kernel `mail-send` ingredient surface.
  MAIL_INSTANCE_NOT_FOUND: 'error',
  // D-153 — Gateway dispatch-outbox.
  DISPATCH_DEPTH_EXCEEDED: 'fatal',
  // D-182 — cli executor failure classification.
  CLI_TOOL_NOT_FOUND: 'error',
  CLI_TOOL_FAILED: 'error',
  CONTAINER_PICK_REQUIRED: 'error',
  CREATE_PLAN_REQUIRED: 'error',
};

export interface RecipeError {
  error_id: string;
  code: RecipeErrorCode;
  message: string;
  severity: ErrorSeverity;
  source: {
    recipe_id: string;
    step_id: string | null;
    ingredient_slug: string | null;
  };
  details: Record<string, unknown>;
  timestamp: string;
  retryable: boolean;
}

/** Default user-facing copy per error code. Surface renderers fall
 *  back to this when no `error.message` is supplied — keeps the
 *  sidebar / approval / install dialog from leaking raw error codes
 *  to the user. Plain English, no jargon, one verb per imperative
 *  recovery hint. */
export const ERROR_MESSAGES: Record<RecipeErrorCode, string> = {
  RECIPE_NOT_FOUND: 'This recipe is no longer installed. Reinstall it from the marketplace to keep using it.',
  RECIPE_VALIDATION_FAILED: 'This recipe failed validation and cannot run as written. The author needs to publish a fix.',
  RECIPE_GUARD_TRIGGERED: 'A guard step asked the recipe to stop. The conditions you set were not met.',
  RECIPE_FAIL_ON_TRIGGERED: 'A fail-on condition stopped the recipe. Open the step to see which check tripped.',
  RECIPE_PREREQUISITE_NOT_MET: 'A prerequisite step did not return what this recipe needs to continue.',
  RECIPE_HOLD_ABANDONED: 'This run was waiting on a peer\u2019s answer, and the dish that started it no longer exists. Nothing will resume it.',
  RECIPE_APPROVAL_TIMEOUT: 'Approval was not granted in time. Re-run the recipe to try again.',
  RECIPE_APPROVAL_DENIED: 'You blocked this step. The recipe stopped without making the change.',
  RECIPE_BUDGET_EXCEEDED: 'This recipe ran longer than its time budget. Increase the budget or simplify a slow step.',
  CHECKPOINT_STEP_NOT_FOUND: 'This run was waiting on approval, but the recipe changed in the meantime. Re-run the recipe to try again.',
  CHECKPOINT_STORE_UNAVAILABLE: 'This recipe needs approval before it can run, but no durable approval storage is configured. Re-run after enabling durable storage.',
  CHECKPOINT_WRITE_FAILED: 'This recipe paused for approval, but the pause could not be saved. Re-run to try again.',
  RECIPE_POLICY_DENIED: 'Recued’s policy gate refused this recipe before it ran. Check the audit log for which steps were denied.',
  INGREDIENT_NOT_FOUND: 'A required ingredient is missing. Reinstall the recipe so its ingredients reload.',
  INGREDIENT_VERSION_MISMATCH: 'An ingredient changed in a breaking way. Update the recipe to the new version.',
  INGREDIENT_SCOPE_INSUFFICIENT: 'This ingredient needs broader access than the credential you saved. Check Connections.',
  INGREDIENT_ENDPOINT_BLOCKED: 'The endpoint this ingredient calls is on the block list. Pick a different ingredient or self-host.',
  INGREDIENT_OUTPUT_VALIDATION_FAILED: 'The service returned data in an unexpected shape. The ingredient author needs to update the parser.',
  INGREDIENT_ADAPTER_ALL_FAILED: 'Every fallback for this ingredient failed. Check the underlying service status.',
  CONNECTION_NOT_BOUND: 'A connection-using ingredient was installed without choosing a connection. Edit the recipe in Kitchen and bind one.',
  CONNECTION_NOT_FOUND: 'No matching connection saved. Add one in Settings → Connections.',
  CONNECTION_AUTH_EXPIRED: 'The saved credential is expired. Sign in again from Settings → Connections.',
  CONNECTION_REFUSED: 'The service refused the connection. Check the endpoint and try again.',
  CONNECTION_TIMEOUT: 'The connection timed out. The service may be slow or unreachable.',
  VAULT_KEY_MISSING: 'A required credential is not in your vault. The install dialog will prompt for it.',
  VAULT_CROSS_PUBLISHER: 'A recipe tried to read another publisher’s credential. Recued blocked the read.',
  OAUTH_EXPIRED: 'Your OAuth token expired. Reconnect the account from Settings.',
  OAUTH_REVOKED: 'The OAuth grant was revoked at the provider. Reconnect to restore access.',
  TOKEN_REFRESH_FAILED: 'A token refresh failed. Reconnect the account so the recipe can keep running.',
  MCP_TOOL_NOT_FOUND: 'The recipe asked for an MCP tool the server no longer exposes. Re-probe the connection or fix the recipe.',
  MCP_TOOL_ERROR: 'The other server was reached and reported an error. This is not a connection problem — retrying unchanged will not help.',
  MCP_TOOL_NOT_CLASSIFIED: 'This MCP tool is not enabled and classified for this connection at the dispatched tier. Review it under Settings → Connections → Tools.',
  MCP_TRANSPORT_NOT_IMPLEMENTED: 'This MCP transport is not wired in this runtime version yet. Use the sse transport, or wait for the upgrade.',
  NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED: 'This notification subtype is not wired in this runtime version yet. Use Slack, Telegram, or in-app, or wait for the upgrade.',
  NOTIFICATION_SEND_FAILED: 'The notification provider reported a delivery failure. The HTTP call reached the provider but the message did not go out — check the connection or recipient.',
  NETWORK_ERROR: 'A network error stopped the request. Check your connection and try again.',
  API_RATE_LIMITED: 'The provider rate-limited this call. Recued will retry on the next run.',
  API_SERVER_ERROR: 'The provider returned a server error. Try again in a few minutes.',
  API_NOT_FOUND: 'The record this recipe expected was not found at the provider.',
  API_FORBIDDEN: 'The provider refused this call. The credential may not have the right permission.',
  STEP_TIMEOUT: 'A step timed out. The provider may be slow, or the step needs a longer timeout.',
  ACTION_DELIVERY_UNCERTAIN: 'Recued could not confirm whether the change reached the provider. Check your CRM before retrying so you do not duplicate the write.',
  TRANSFORM_ERROR: 'A transform failed. Open the step to see which value did not match what the transform expected.',
  TRANSFORM_INVALID_INPUT: 'A transform received input it could not handle. Check the upstream step.',
  TRANSFORM_TIMEOUT: 'A transform took too long. Reduce the data it processes or simplify the expression.',
  CONDITION_PARSE_ERROR: 'A condition string failed to parse. The recipe author needs to fix the operator or operands.',
  AI_LLM_UNAVAILABLE: 'No model is available right now. Add a free-pool key or set a BYOK slot.',
  AI_MODEL_REFUSED: 'The selected model refused to produce this output. Review the input, or use a non-model path when one is available.',
  AI_OUTPUT_INVALID: 'The model returned an output Recued could not use. The recipe will retry on the next run.',
  AI_TIMEOUT: 'The model took too long. Try a faster model or simplify the prompt.',
  AI_TOKEN_BUDGET_EXCEEDED: 'The recipe used its token budget for this run. Add a fresh free-pool key or upgrade.',
  AI_RESPONSE_PARSE_FAILED: 'The model output could not be parsed. The recipe will retry once more.',
  AI_RESPONSE_VALIDATION_FAILED: 'The model output did not match the expected shape. The recipe will retry.',
  DOM_SELECTOR_MISSING: 'A DOM selector for this page was missing. The ingredient author needs to fix the recipe.',
  DOM_SELECTOR_NOT_FOUND: 'The page changed and Recued could not find an expected element. The ingredient author needs an update.',
  DOM_CROSS_ORIGIN: 'Recued cannot read this element from another origin. Open the page directly to use the recipe.',
  DOM_WRITE_FAILED: 'Recued could not write to the page. Refresh and try again, or report the broken selector.',
  DOM_PAGE_NOT_MATCHING: 'This page does not match the recipe’s trigger. Open a matching page first.',
  CACHE_MISS: 'A cached value was missing. Recued fetched it fresh and continued.',
  CONTEXT_SIZE_EXCEEDED: 'A step produced more data than Recued can carry to the next step. Filter the upstream output.',
  ATTESTATION_VIOLATION: 'Recued blocked a step that did not match its signed contract. The recipe author must republish.',
  ROLE_RESTRICTION: 'This recipe needs a live browser tab. Run it from the extension instead of the server.',
  STORAGE_PRESSURE: 'Storage is under pressure. The server is keeping reads up but rejecting new writes for now.',
  QUOTA_EXCEEDED: 'A quota was exceeded. Free space in Connections, Server → Collections, or upgrade for more room.',
  DATA_NAMESPACE_READONLY: 'This namespace is owned by the warehouse and is read-only. Use data.shared.* for recipe writes.',
  ACCOUNT_MISMATCH: 'Your extension and server are signed in to different accounts. Re-pair to sync them.',
  TIER_LIMIT_EXCEEDED: 'A tier limit was reached. Add a fresh free-pool key, switch to BYOK, or upgrade.',
  SHARED_KEY_INVALID: 'A shared-storage key did not pass validation. Check the key prefix and length.',
  SERVER_NOT_REACHABLE: 'Your paired server is not reachable. Recued saved the change locally; it will sync on reconnect.',
  VALUE_TOO_LARGE: 'A value is too large for shared storage. Trim it under 10 MB or store it in a collection.',
  DRAINING: 'The server is restarting. Recued will retry the call when it is back up.',
  NOT_READY: 'The server is still starting. Try again in a few seconds.',
  LOCK_HELD: 'Another server process is using this data folder. Stop the other process before starting a new one.',
  CRASH_LOOP_ACTIVE: 'The server has restarted too often and paused user-class writes. Run server.resetCrashLoop or check the logs.',
  COLLECTION_NOT_FOUND: 'A collection this recipe needs is not registered on the server. Add it under Server → Collections.',
  COLLECTION_SOURCE_UNREACHABLE: 'A collection source is unreachable. Reconnect from Server → Collections to resume the sync.',
  WEBHOOK_UNAVAILABLE: 'Inbound webhooks need a public address or a tunnel. Set webhook_port and a public host in Server → Config.',
  TRIGGER_PATTERN_INVALID: 'The trigger pattern did not parse. Check the operator and the namespace path.',
  TRIGGER_RECIPE_NOT_INSTALLED: 'The recipe a trigger points to is not installed. Reinstall it or remove the trigger.',
  ARCHIVE_JOB_UNKNOWN: 'That archive job is unknown. It may have completed and aged out.',
  ARCHIVE_IMPORT_IN_PROGRESS: 'Another archive import is already running. Wait for it to finish before starting a new one.',
  COLLECTION_RECORD_NOT_FOUND: 'No record matches that id in this collection.',
  EVENT_TRIGGER_BACKPRESSURE: 'An event trigger fired faster than the recipe could keep up. Recued dropped the surplus events.',
  ON_FAILURE_HANDLER_UNKNOWN: 'This recipe’s on_failure handler is not installed. Install the handler recipe first, then install this one.',
  ON_FAILURE_HANDLER_NOT_REACTIVE: 'This recipe’s on_failure handler is not a reactive recipe. Handlers must declare trigger_steps so the engine can wire the failure signal.',
  ON_FAILURE_HANDLER_MISSING_WATCHER: 'This recipe’s on_failure handler is missing a recipe-watcher trigger step. Add one so failures can reach the handler.',
  // D-118 — data.service platform.
  SERVICE_NOT_FOUND: 'No service is enrolled under that slug. Add it under Server → Services or pick a different one in this recipe.',
  SERVICE_TEMPLATE_UNAVAILABLE: 'The service template this recipe needs is not installed on the server. Install it from the marketplace.',
  SERVICE_PLATFORM_MISMATCH: 'This service template is for a different operating system than your server. Pick the variant that matches.',
  SERVICE_INSTALL_UNAVAILABLE: 'This service has no automatic installer. Follow the install hint shown next to the service.',
  SERVICE_INSTALL_FAILED: 'The installer reported an error. Check the install log under Server → Services for the underlying message.',
  SERVICE_UPGRADE_FAILED: 'The upgrade did not complete. The previous version is still in place; check the upgrade log for the underlying error.',
  SERVICE_UNINSTALL_FAILED: 'The uninstaller reported an error. The service may be partially removed; check the uninstall log.',
  SERVICE_ALREADY_RUNNING: 'The service is already running. Recued returned the current status without restarting it.',
  SERVICE_NOT_RUNNING: 'This operation needs the service to be running. Start it under Server → Services and try again.',
  SERVICE_PERMANENTLY_CRASHED: 'The service crashed five times in a row and Recued paused it. Click Clear & retry under Server → Services to resume.',
  SERVICE_OP_NOT_SUPPORTED: 'This service does not support that operation. Pick one from its declared invoke list.',
  SERVICE_INPUT_INVALID: 'A value passed to this service did not match the declared input shape. Check the recipe’s inputs against the template.',
  SERVICE_STORAGE_PRESSURE: 'There is not enough free space to run this service operation. Free disk space or raise the service quota.',
  SERVICE_INVOKE_CONCURRENCY: 'Too many service operations are running at once. Wait for one to finish and try again, or raise the concurrency limit under Settings → Server.',
  SERVICE_HEALTH_TIMEOUT: 'The service started but did not become healthy in time. Check the service logs for the underlying issue.',
  SERVICE_CHECK_FAILED: 'A check on the service did not pass. Open the service detail to see which check tripped.',
  SERVICE_DOWNLOAD_SHA_MISMATCH: 'The downloaded file did not match its expected checksum. Recued blocked the install to protect against tampering.',
  // D-119 Phase 15 — execution scope.
  EXECUTION_SCOPE_TOO_WIDE: 'This recipe claims to run somewhere it cannot. Its declared execution scope is wider than the ingredients allow — the author needs to narrow the scope or change the ingredients.',
  EXECUTION_SCOPE_INCOMPATIBLE: 'This recipe cannot run on this device. Install it on a paired runtime that matches its execution scope (extension for device-only, server for server-only).',
  // D-126 P4.3 — manifest validator codes (graduated).
  INGREDIENT_KIND_MISSING: 'This ingredient is missing the required `kind` field. The author needs to declare which adapter handles it.',
  INGREDIENT_KIND_INVALID: 'This ingredient declares an unknown adapter kind. Update Recued or ask the author to fix the manifest.',
  INGREDIENT_KIND_MISSING_FIELD: 'This ingredient is missing an input field its adapter requires. The author needs to update the manifest.',
  INGREDIENT_KIND_FIELD_FORBIDDEN: 'This ingredient declares an input field that does not belong to its adapter kind. The author likely misclassified it.',
  INGREDIENT_KIND_TIER_MISMATCH: 'This ingredient declares a risk tier its adapter cannot honor. The author needs to fix the kind or the tier.',
  CONNECTION_KIND_INVALID: 'This connection ingredient is missing or misnames its connection_kind. The author needs to set api, mcp, or notification.',
  CONNECTION_KIND_MISSING_FIELD: 'This connection ingredient is missing a required input field for its connection_kind. The author needs to update the manifest.',
  CONNECTION_PICKER_INVALID: 'This connection ingredient does not bind its connection field to a config picker. The author needs to use {{config.<X>}}.',
  // D-127 P1.2 — mail-send error taxonomy.
  MAIL_SEND_NOT_CAPABLE: 'This mail account is not configured to send. Re-enroll it with sending enabled, or pick a different mail account.',
  MAIL_SEND_AUTH_FAILED: 'The mail account refused the send. Reconnect the account from Settings → Connections.',
  MAIL_SEND_RECIPIENT_INVALID: 'A recipient address was rejected by the mail provider. Check the addresses for typos.',
  MAIL_SEND_NETWORK_FAILED: 'A network error stopped the send. Check your connection and try again.',
  MAIL_SEND_SELF_LOOP_TO: 'This recipe is configured to send mail to itself, which is almost always a configuration mistake. Adjust the recipient or move the address to bcc.',
  MAIL_SEND_APPEND_FAILED: 'The mail was sent but Recued could not save a copy to your Sent folder. The recipient still received it; your Sent folder will reconcile on the next sync.',
  MAIL_SEND_ATTACHMENT_UNRESOLVABLE: 'An attachment could not be read, so the email was not sent. Re-drop the file, or send without it.',
  // D-127 P2.1 — kernel `mail-send` ingredient surface.
  MAIL_INSTANCE_NOT_FOUND: 'No mail account with that name is connected. Pick a different account, or connect this one in Settings → Mail.',
  // D-153 — Gateway dispatch-outbox.
  DISPATCH_DEPTH_EXCEEDED: 'Recued stopped this recipe — its tool calls nested too many levels deep, which signals a runaway loop. Check the recipe for a step that re-triggers the same chain.',
  // D-182 — cli executor failure classification.
  CLI_TOOL_NOT_FOUND: 'A local tool this recipe runs was not found. Install the tool on the server, or check that it is on the server’s PATH.',
  CLI_TOOL_FAILED: 'A local tool this recipe runs exited with an error. Open the run to see the tool’s output.',
  CONTAINER_PICK_REQUIRED: 'This create needs you to choose which container it belongs to (a team, workspace, or project). Answer the request that was raised, then it will finish on its own.',
  CREATE_PLAN_REQUIRED: 'This create needs to make a new container (a project) first. Confirm the request that was raised and it will create it, then finish on its own.',
};

/** Return a default user-facing message for the code, never empty.
 *  Falls back to the code itself when an unknown value sneaks in
 *  (forward-compatibility for codes added after this UI build). */
/** D-214 admission input — WHO or WHAT the failure is attributable to.
 *
 *  Attribution is what decides whether a failure is EVIDENCE about the approach
 *  at all. ⚠ This paragraph used to lean on a lower negative candidacy floor
 *  ("choosing the wrong single tool is exactly what users correct"); D-219 slice
 *  7 retired that clause and `execution-case.ts` now states the opposite — the
 *  bar is the same in both directions. The attribution point never depended on
 *  the floor and stands on its own: a failure is evidence only when it is
 *  attributable to the CHOICE. A stopwatch (`RECIPE_BUDGET_EXCEEDED`), a lost ack
 *  (`ACTION_DELIVERY_UNCERTAIN`) or a rate limit says nothing about whether the
 *  tool suited the ask — it says something about the moment. Filing those as
 *  precedent is how an LLM bench run produced a corpus that was two-thirds
 *  stopwatch noise.
 *
 *    `choice`      — the tool, scope, arguments or recipe were wrong for this ask.
 *                    "For this ask, not tool A" is a real lesson.
 *    `environment` — transient or external to the decision. Retrying later, or
 *                    elsewhere, could succeed. NOT evidence against the choice.
 *    `owner`       — the owner or their policy refused. A judgement about a
 *                    moment, never a capability fact; surface it, never file it
 *                    as "this does not work".
 *    `conditional` — the recipe DECIDED NOT TO ACT, and was right to. A guard
 *                    tripped, a fail-on matched, a prerequisite was absent.
 *                    Nothing broke and nothing was chosen badly: the flow worked
 *                    exactly as written. Treating a by-design stop as a failure
 *                    would teach a model to avoid a recipe for doing its job.
 *
 *  ⛔ **The tie-break is `environment`.** When a code could be either, the
 *  conservative direction is to REFUSE to file: a missing lesson costs nothing,
 *  a false lesson is durable and shown to a model.
 *
 *  ⚠ This is a judgement made ONCE, in the open, in a typed table — not
 *  re-guessed per observation. `Record<RecipeErrorCode, _>` makes the typechecker
 *  demand an entry for every new code, so the judgement cannot be skipped.
 *  Whether a case is USEFUL remains the owner's call at the chat boundary; this
 *  table only decides what is eligible to be offered. */
export type ErrorAttribution =
  | 'choice'
  | 'environment'
  | 'owner'
  | 'conditional';

export const ERROR_ATTRIBUTION: Record<RecipeErrorCode, ErrorAttribution> = {
  // D-234 § 234.4n — the OWNER deleted the dish out from under a held run.
  RECIPE_HOLD_ABANDONED: 'owner',
  RECIPE_NOT_FOUND: 'choice',
  RECIPE_VALIDATION_FAILED: 'choice',
  RECIPE_GUARD_TRIGGERED: 'conditional',
  RECIPE_FAIL_ON_TRIGGERED: 'conditional',
  RECIPE_PREREQUISITE_NOT_MET: 'conditional',
  RECIPE_APPROVAL_TIMEOUT: 'owner',
  RECIPE_APPROVAL_DENIED: 'owner',
  RECIPE_BUDGET_EXCEEDED: 'environment',
  CHECKPOINT_STEP_NOT_FOUND: 'environment',
  CHECKPOINT_STORE_UNAVAILABLE: 'environment',
  CHECKPOINT_WRITE_FAILED: 'environment',
  RECIPE_POLICY_DENIED: 'owner',
  INGREDIENT_NOT_FOUND: 'choice',
  INGREDIENT_VERSION_MISMATCH: 'choice',
  INGREDIENT_SCOPE_INSUFFICIENT: 'choice',
  INGREDIENT_ENDPOINT_BLOCKED: 'owner',
  INGREDIENT_OUTPUT_VALIDATION_FAILED: 'choice',
  INGREDIENT_ADAPTER_ALL_FAILED: 'environment',
  CONNECTION_NOT_BOUND: 'choice',
  CONNECTION_NOT_FOUND: 'choice',
  CONNECTION_AUTH_EXPIRED: 'environment',
  CONNECTION_REFUSED: 'environment',
  CONNECTION_TIMEOUT: 'environment',
  VAULT_KEY_MISSING: 'choice',
  VAULT_CROSS_PUBLISHER: 'owner',
  OAUTH_EXPIRED: 'environment',
  OAUTH_REVOKED: 'environment',
  TOKEN_REFRESH_FAILED: 'environment',
  MCP_TOOL_NOT_FOUND: 'choice',
  MCP_TOOL_ERROR: 'environment',
  MCP_TOOL_NOT_CLASSIFIED: 'owner',
  MCP_TRANSPORT_NOT_IMPLEMENTED: 'choice',
  NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED: 'choice',
  NOTIFICATION_SEND_FAILED: 'environment',
  NETWORK_ERROR: 'environment',
  API_RATE_LIMITED: 'environment',
  API_SERVER_ERROR: 'environment',
  API_NOT_FOUND: 'environment',
  API_FORBIDDEN: 'choice',
  STEP_TIMEOUT: 'environment',
  ACTION_DELIVERY_UNCERTAIN: 'environment',
  TRANSFORM_ERROR: 'choice',
  TRANSFORM_INVALID_INPUT: 'choice',
  TRANSFORM_TIMEOUT: 'environment',
  CONDITION_PARSE_ERROR: 'choice',
  AI_LLM_UNAVAILABLE: 'environment',
  AI_MODEL_REFUSED: 'environment',
  AI_OUTPUT_INVALID: 'environment',
  AI_TIMEOUT: 'environment',
  AI_TOKEN_BUDGET_EXCEEDED: 'environment',
  AI_RESPONSE_PARSE_FAILED: 'environment',
  AI_RESPONSE_VALIDATION_FAILED: 'environment',
  DOM_SELECTOR_MISSING: 'choice',
  DOM_SELECTOR_NOT_FOUND: 'choice',
  DOM_CROSS_ORIGIN: 'choice',
  DOM_WRITE_FAILED: 'environment',
  DOM_PAGE_NOT_MATCHING: 'choice',
  CACHE_MISS: 'environment',
  CONTEXT_SIZE_EXCEEDED: 'choice',
  ATTESTATION_VIOLATION: 'owner',
  ROLE_RESTRICTION: 'choice',
  STORAGE_PRESSURE: 'environment',
  QUOTA_EXCEEDED: 'environment',
  DATA_NAMESPACE_READONLY: 'choice',
  ACCOUNT_MISMATCH: 'environment',
  TIER_LIMIT_EXCEEDED: 'environment',
  SHARED_KEY_INVALID: 'choice',
  SERVER_NOT_REACHABLE: 'environment',
  VALUE_TOO_LARGE: 'choice',
  DRAINING: 'environment',
  NOT_READY: 'environment',
  LOCK_HELD: 'environment',
  CRASH_LOOP_ACTIVE: 'environment',
  COLLECTION_NOT_FOUND: 'choice',
  COLLECTION_SOURCE_UNREACHABLE: 'environment',
  WEBHOOK_UNAVAILABLE: 'environment',
  TRIGGER_PATTERN_INVALID: 'choice',
  TRIGGER_RECIPE_NOT_INSTALLED: 'choice',
  ARCHIVE_JOB_UNKNOWN: 'environment',
  ARCHIVE_IMPORT_IN_PROGRESS: 'environment',
  COLLECTION_RECORD_NOT_FOUND: 'environment',
  EVENT_TRIGGER_BACKPRESSURE: 'environment',
  ON_FAILURE_HANDLER_UNKNOWN: 'choice',
  ON_FAILURE_HANDLER_NOT_REACTIVE: 'choice',
  ON_FAILURE_HANDLER_MISSING_WATCHER: 'choice',
  SERVICE_NOT_FOUND: 'choice',
  SERVICE_TEMPLATE_UNAVAILABLE: 'choice',
  SERVICE_PLATFORM_MISMATCH: 'choice',
  SERVICE_INSTALL_UNAVAILABLE: 'choice',
  SERVICE_INSTALL_FAILED: 'environment',
  SERVICE_UPGRADE_FAILED: 'environment',
  SERVICE_UNINSTALL_FAILED: 'environment',
  SERVICE_ALREADY_RUNNING: 'environment',
  SERVICE_NOT_RUNNING: 'environment',
  SERVICE_PERMANENTLY_CRASHED: 'environment',
  SERVICE_OP_NOT_SUPPORTED: 'choice',
  SERVICE_INPUT_INVALID: 'choice',
  SERVICE_STORAGE_PRESSURE: 'environment',
  SERVICE_INVOKE_CONCURRENCY: 'environment',
  SERVICE_HEALTH_TIMEOUT: 'environment',
  SERVICE_CHECK_FAILED: 'environment',
  SERVICE_DOWNLOAD_SHA_MISMATCH: 'owner',
  EXECUTION_SCOPE_TOO_WIDE: 'choice',
  EXECUTION_SCOPE_INCOMPATIBLE: 'choice',
  INGREDIENT_KIND_MISSING: 'choice',
  INGREDIENT_KIND_INVALID: 'choice',
  INGREDIENT_KIND_MISSING_FIELD: 'choice',
  INGREDIENT_KIND_FIELD_FORBIDDEN: 'choice',
  INGREDIENT_KIND_TIER_MISMATCH: 'choice',
  CONNECTION_KIND_INVALID: 'choice',
  CONNECTION_KIND_MISSING_FIELD: 'choice',
  CONNECTION_PICKER_INVALID: 'choice',
  MAIL_SEND_NOT_CAPABLE: 'choice',
  MAIL_SEND_AUTH_FAILED: 'environment',
  MAIL_SEND_RECIPIENT_INVALID: 'choice',
  MAIL_SEND_NETWORK_FAILED: 'environment',
  MAIL_SEND_SELF_LOOP_TO: 'choice',
  MAIL_SEND_APPEND_FAILED: 'environment',
  MAIL_SEND_ATTACHMENT_UNRESOLVABLE: 'choice',
  MAIL_INSTANCE_NOT_FOUND: 'choice',
  DISPATCH_DEPTH_EXCEEDED: 'owner',
  CLI_TOOL_NOT_FOUND: 'choice',
  CLI_TOOL_FAILED: 'environment',
  CONTAINER_PICK_REQUIRED: 'owner',
  CREATE_PLAN_REQUIRED: 'owner',
};

/** Codes attributable to the owner's own refusal. Derived from the one table
 *  above rather than hand-listed — a second copy of a closed vocabulary rots
 *  silently, because a SUBSET still typechecks. */
export const OWNER_ATTRIBUTED_ERROR_CODES: ReadonlySet<string> = new Set(
  (Object.keys(ERROR_ATTRIBUTION) as RecipeErrorCode[])
    .filter((code) => ERROR_ATTRIBUTION[code] === 'owner'),
);

/** True when a failure carries a lesson about the CHOICE. */
export const isChoiceAttributableFailure = (
  codes: readonly string[],
): boolean => codes.some(
  (code) => ERROR_ATTRIBUTION[code as RecipeErrorCode] === 'choice',
);

/** True when EVERY recorded code is environmental — the only case where a
 *  failure is positively known to carry no lesson about the choice.
 *
 *  ⛔ THE POLARITY IS DELIBERATE, and the inverse was tried first. Gating
 *  admission on "is positively choice-attributable" refuses every failure whose
 *  cause was not recorded — including an activity-level error with no run and no
 *  code — which broke 9 existing tests whose claims were about pairing, not
 *  attribution. That is too aggressive: it would silently stop filing whenever a
 *  code is missing or unmapped.
 *
 *  This predicate refuses only what we can POSITIVELY attribute to the moment:
 *
 *    []                                    -> false  (no information; unchanged)
 *    ['RECIPE_BUDGET_EXCEEDED']            -> TRUE   (a stopwatch; refuse)
 *    ['INGREDIENT_NOT_FOUND']              -> false  (a real lesson)
 *    ['NETWORK_ERROR','INGREDIENT_NOT_...'] -> false  (mixed: a lesson survives)
 *    ['SOME_UNMAPPED_STRING']              -> false  (unknown; unchanged)
 *
 *  Status quo for everything unknown, removal of what is known to be noise. */
export const isEnvironmentOnlyFailure = (
  codes: readonly string[],
): boolean => codes.length > 0 && codes.every(
  (code) => ERROR_ATTRIBUTION[code as RecipeErrorCode] === 'environment',
);

export function defaultErrorMessage(code: RecipeErrorCode | string): string {
  const known = ERROR_MESSAGES[code as RecipeErrorCode];
  if (known) return known;
  return `Recipe stopped (${code}).`;
}
