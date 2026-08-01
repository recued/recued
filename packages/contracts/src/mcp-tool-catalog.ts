/** D-138 Phase 1 — closed-list registry of MCP-published tool names.
 *
 *  The MCP server (`backend/server/src/mcp-server.ts`) exposes a small
 *  set of meta-tools (`recued_*`) plus dynamic per-ingredient tools.
 *  Internal rpcs (`contact.*`, `housekeeping.*`, etc.) are NOT
 *  surfaced through MCP — channel isolation is structural per the
 *  three-channel invariant (WS-rpc=ext, MCP=external agents,
 *  internal=engine).
 *
 *  This module exists so D-138's "RPC access scope" guarantee
 *  (Reviewer #12) has a single source of truth + a ratchet test that
 *  can assert which rpc namespaces are excluded from the MCP catalog.
 *  Adding a new MCP-exposed tool is one entry here; adding an
 *  internal rpc namespace requires NO change here (default-exclude
 *  is the discipline). The ratchet test asserts the
 *  `contact.merge.*` namespace stays excluded so future rpc
 *  registrations can't accidentally bridge it onto the MCP surface.
 *
 *  Note: the `MCP_TOOL_CATALOG` enumerates only the *meta* tool names
 *  hard-coded in the MCP server. Dynamic per-ingredient tools (named
 *  `recued_ingredient_<slug>`) are generated at boot from the
 *  installed ingredient registry and don't enter this list — they're
 *  recognized by the `recued_ingredient_` prefix at runtime. */

/** Closed list of meta-tool names the MCP server publishes. Mirrors
 *  the `TOOLS` const in `backend/server/src/mcp-server.ts`. Adding
 *  a new meta-tool requires updating both lists in lockstep — a
 *  ratchet test asserts they agree. */
export const MCP_TOOL_CATALOG = [
  'recued_listRecipes',
  'recued_getRecipe',
  'recued_listIngredients',
  'recued_runRecipe',
  'recued_getAudit',
  'recued_saveRecipe',
  'recued_dataTimeline',
  // D-136 §A.13 P7.D — MCP consumer surface
  'recued_registryDescribe',
  'recued_enrichmentRead',
  'recued_vectorSimilaritySearch',
  // D-139 P5 — contact-rooted engagement evidence read (body-stripped
  // projection; default-off per the per-token tool checklist).
  'recued_contactEngagementsList',
] as const;

export type McpToolName = (typeof MCP_TOOL_CATALOG)[number];

/** Prefix used for dynamically-generated per-ingredient tools. Tools
 *  matching this prefix are NOT in `MCP_TOOL_CATALOG` (since they're
 *  generated at boot from the installed ingredient registry); the
 *  prefix is published here so downstream consumers + ratchet tests
 *  can reason about the dynamic surface uniformly. */
export const MCP_INGREDIENT_TOOL_PREFIX = 'recued_ingredient_';

/** O(1) membership check. */
export const MCP_TOOL_CATALOG_SET: ReadonlySet<string> = new Set(MCP_TOOL_CATALOG);

/** Returns true iff `name` is a published MCP tool — either a
 *  meta-tool from the closed list OR a dynamic per-ingredient tool. */
export const isMcpToolName = (name: string): boolean => {
  if (MCP_TOOL_CATALOG_SET.has(name)) return true;
  return name.startsWith(MCP_INGREDIENT_TOOL_PREFIX);
};

/** D-138 Reviewer #12 — namespaces that MUST stay out of the MCP
 *  catalog. Each entry is the rpc method-name prefix that's reserved
 *  for local-UI / user-action only. The ratchet test asserts no
 *  member of `MCP_TOOL_CATALOG` collides with any reserved prefix.
 *  Prefixes are matched against the full rpc method name (e.g.
 *  `'contact.merge.list'.startsWith('contact.merge.')` is true). */
export const MCP_RESERVED_RPC_PREFIXES = [
  // D-221 — pack-owned Records carry arbitrary pack-defined business data.
  // Listing, exporting, deleting, quota/retention changes, and accounting
  // repair are owner control-plane actions; external agents reach Records only
  // through installed, grant-gated Tier-P operations.
  'records.',
  // D-205 #5 — selective CRM promotion. Pulling a stranger out of a 10k-row CRM
  // and into the personal contact graph is a judgement about WHO YOU KNOW — the
  // same class of decision as a merge, and the exact judgement `hydrate_on_match`
  // refuses to make on your behalf. An agent may READ the graph (subject to the
  // `data.contact` collection grant); it may not decide who belongs in it.
  'contact.import.',
  'contact.merge.',
  'housekeeping.',
  // LAN-URL kickstart — `network.local_urls` is a local-UI reachability read
  // (the server's own bind addresses). An MCP-channel agent has no need to
  // enumerate them; reserve the whole `network.` prefix like passport/hostname.
  'network.',
  // D-167 P5 — per-scope PII egress policy is local-UI-only privacy
  // config. An MCP-channel agent must never read the user's egress
  // posture (which collections / providers are cloud-blocked) nor flip a
  // switch to widen egress. Reserve the whole `pii.` namespace.
  'pii.',
  // Grant-foundation slice 3 (D-187 amendment) — the unified (contract × grant)
  // matrix CRUD is operator-only: a contracted MCP agent must NEVER call
  // contract.grant.write to widen its OWN grants (the core fail-closed invariant —
  // admission would become self-granting). Reserve the whole contract.grant. family.
  'contract.grant.',
  // D-138 P5 — upstream-merge outbox is local-UI only; MCP agents
  // must never invoke a destructive vendor merge.
  'upstream_merge.',
  // D-145 PA8 § A.4.4 — `contact_alias` is per-pair private vocabulary.
  // Aliases ("mom" / `bob.smith.42` Facebook id) are NEVER returned in
  // MCP responses to external AI clients — there's no per-token
  // override. Reserve every `contact.alias.*` rpc + the planned
  // `contact.identity.*` rpc family for local-UI only.
  'contact.alias.',
  'contact.identity.',
  // D-148 W3.FU — Per-path Exposure state mutators are operator-only.
  // External AI agents must never drive the LAN/public/MCP-exposure
  // toggle grid; channel-isolation invariant.
  'exposure.',
  // D-148 follow-up #4 — BYO cert upload + remove + list are operator-
  // only. External AI agents must never upload / replace / remove a TLS
  // cert; the cert + private-key pair is the server's identity to its
  // pinned clients. Channel-isolation invariant.
  'tls_domain.',
  // D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud`
  // unbind is operator-only. External AI agents must never tear down a
  // Pro-managed DDNS handle; the release reshapes every paired
  // client's server-address pin. Channel-isolation invariant.
  'pro_acme.',
  // R27 delta-B — user-initiated DDNS pause/resume (`ddns.setEnabled` /
  // `ddns.status`) is operator-only local-UI config. An external AI agent
  // must never pause a user's DDNS publication (it would take the handle
  // offline) nor read the pause posture. Channel-isolation invariant.
  'ddns.',
  // D-137 P5 follow-on § A.9 — inbound-token issuance / grants edit /
  // revoke / delete are operator-only (Bob configures from Settings →
  // MCP Tokens). External AI agents must never call this surface; the
  // bearer-mint endpoint lets a caller upgrade their own access by
  // issuing a fresh max-grants token, and the grants edit could widen
  // a peer's surface mid-call. Channel-isolation invariant.
  'chat.inbound_token.',
  // D-214 — explicit execution feedback trains owner-scoped historical
  // evidence. An MCP agent must not mark its own work accepted or poison the
  // owner's future planner context.
  'chat.execution.',
  // D-149 P3 § A.3 — Public Reception registry rpc family is operator-
  // only. External AI agents must never create / enable / revoke /
  // rotate / extend reception endpoints (the public-facing surface
  // exposes user data to anonymous visitors; an MCP-channel mutation
  // would be catastrophic — e.g., a compromised AI agent could create
  // an `intake_form` endpoint exposing every commitment + revoke the
  // user's review path). Channel-isolation invariant.
  'reception.',
  // D-148 § A.4.4 — webclient/bridge bearer rotation is operator-only.
  // The rpc reissues a fresh bearer + invalidates the old, then
  // broadcasts the new plaintext on the pair-scoped bus so the
  // targeted client re-auths seamlessly. External AI agents must
  // never drive credential rotation — a compromised agent could
  // forcibly invalidate every paired client's session in a loop.
  // Channel-isolation invariant.
  'token.',
  // D-148 § A.6.5 — operator-initiated TLS cert renewal is operator-
  // only. A compromised AI agent could force-rotate the cert, briefly
  // breaking every pinned client's verify step + flooding the audit
  // log. Distinct from `tls_domain.` (BYO cert upload / list, also
  // reserved); the `tls.` prefix covers the rotation surface.
  // Channel-isolation invariant.
  'tls.',
  // R26.4 Delta 3 (D-148 § A.11) — Key Health + Rotation Center is
  // operator-only. `key.rotate` rotates the server identity key / marks
  // a key class compromised (cascading dependent rotations); `key.health`
  // discloses the full per-class key-health bundle incl. compromise
  // flags. A compromised AI agent calling `key.rotate` could de-pair
  // every client by rotating `server_identity_key`, or mark a key
  // compromised to force a disruptive cascade; `key.health` leaks the
  // key inventory + rotation posture. Channel-isolation invariant.
  'key.',
  // D-148 § A.5.3 / § A.6.5 — Pro auth bearer-token slot management
  // is operator-only. A compromised AI agent calling `pro.signOut`
  // would stop the renewal cycle (the renewer would route to
  // `subscription_required` immediately); calling
  // `pro.authenticate(...)` could swap in an attacker-controlled
  // bearer that exfiltrates state through the cloud helper's
  // signature-verified call path. `pro.current` is also reserved
  // because it leaks the existence of an authenticated subscription
  // even via the safe-display fragment. Channel-isolation invariant.
  'pro.',
  // D-148 § A.6.5 + § A.9 — webclient passport-fetch verify path is
  // operator-only. `passport.fetch` mints a fresh signed
  // `support_redacted` passport projection per call (carrying identity
  // public-key + cert fingerprint + DDNS handle); a compromised AI
  // agent could enumerate the verify substrate at high cadence to
  // exfiltrate identity fingerprints + LAN claims through the
  // ledger-free path (the rpc deliberately skips the
  // `passport.exported` audit row to avoid flood-writing on every
  // reconnect — that audit-row exemption is safe only behind the
  // reserved-prefix gate). The future `passport.export` operator rpc
  // (still TBD) lives behind the same prefix. Channel-isolation
  // invariant.
  'passport.',
  // D-148 § A.2.1 / § A.6.5 — pair-blob credential ceremony is
  // operator-only. `pair.mint` issues a fresh signed pair-blob that
  // bootstraps a NEW device credential; `pair.consume` exchanges that
  // blob for a `client_tokens` bearer; `pair.registerRecoveryKey`
  // binds the realm to a 24-word recovery mnemonic on first call (and
  // verifies on every subsequent call); `pair.list` exposes the device
  // roster with labels + connection state; `pair.revoke` closes the
  // WS for a device + marks it revoked durably. A compromised AI
  // agent calling any of these could (a) mint a pair-blob relayed to
  // an attacker device, (b) loop-revoke every paired client to deny
  // service, (c) overwrite the recovery-key sentinel on a fresh-realm
  // server, or (d) enumerate the device roster. `pair.consume` is
  // unauthenticated by construction (the rendezvous secret IS the
  // auth signal) but still mints a credential, so it belongs behind
  // the same prefix — channel-isolation is "MCP agents never
  // participate in credential issuance", not "MCP agents can call
  // unauthenticated rpcs". Channel-isolation invariant.
  'pair.',
  // Reactive-substrate slice 1 — the automation-rule families are
  // local-UI only: a
  // compromised AI agent calling `schedules.{create,update,delete}` /
  // `triggers.{create,update,delete}` / `auto_run.update` could disarm
  // the user's standing automations (silent denial), re-arm a
  // circuit-tripped recipe to force failed actions to retry, attach a
  // trigger that fires an arbitrary installed recipe on warehouse
  // changes, or schedule one on a cadence — autonomous-execution
  // policy is the OWNER's surface (#automation / the recipes panel),
  // never an MCP-channel agent's. The list reads also disclose
  // automation topology (which recipes watch what, when they fire).
  // Channel-isolation invariant.
  'schedules.',
  'triggers.',
  'auto_run.',
  // D-179 — a recipe's INSTALL config (its default-dish overlay) is a base
  // applied to every dishless run. Setting it is owner autonomous-execution
  // policy (same stance as the automation families above); an MCP-channel
  // agent must never edit the config every future run inherits.
  'recipe_config.',
  // Reactive-substrate slice 2 (poll-manager / G6) — the watch surface
  // is the same autonomous-execution-policy class as the three families
  // above: `watch.update` pauses/resumes a connection-entity poll loop
  // (silent denial of every subscribed reactive recipe, or re-arming a
  // poll the user paused), and `watch.list` discloses automation
  // topology PLUS connection names + vendor entities being watched.
  // Channel-isolation invariant.
  'watch.',
  // D-163 Slice C — Settings → Notifications rpc family is local-UI
  // only. A compromised AI agent calling
  // `notifications.{describe,set_channel,set_verification_phrase}`
  // could (a) disable every approval-bearing channel so no `ask`
  // reaches the user (silent-strand), (b) enable a togglable channel
  // pointing at an attacker-controlled credential to redirect approval
  // fan-out, or (c) overwrite the anti-phishing verification phrase
  // rendered on the email ask landing page (the user's lone tell that
  // the page is genuine). The block's readiness-probe gate alone is
  // insufficient — a credential the user enrolled for legitimate Slack
  // delivery can be flipped on/off by anyone with write access here.
  // Channel-isolation invariant.
  'notifications.',
  // D-145 PA10 follow-on — `packs.install` is local-UI only. A pack
  // install transaction writes recipes + body-content grants + per-pair
  // Standing Instruction rows in one atomic step; a compromised AI
  // agent calling `packs.install` could ship attacker-controlled SI
  // rules that disable approval gates / raise tier ceilings / collide
  // redirects (forcing `cancelled_si_conflict` halts on user requests),
  // OR land body-content MCP grants the user never approved, OR upsert
  // arbitrary recipes into the per-pair store. Settings → Packs is the
  // sole writer; per-pair only, no MCP exposure. Channel-isolation
  // invariant.
  'packs.',
  // D-170 — `ingredient.install` / `ingredient.uninstall` are local-UI only
  // (Kitchen / Connection Setup). Authoring installs a callable CAPABILITY:
  // operations mapped to risk + approval, entity schemas, audit-facing
  // operation ids, and the catalog the gateway dispatches against. A
  // compromised MCP-channel agent calling `ingredient.install` could author
  // and install its own capability surface — a read op mis-declared as never-
  // approve, a destructive op tagged `read`, a private connector wrapping an
  // arbitrary local binary — bypassing the very grant / approval / audit model
  // D-170 exists to uphold; calling `ingredient.uninstall` could tear out a
  // capability a recipe depends on. Settings / Kitchen UI is the sole writer;
  // per-pair only, no MCP exposure. Channel-isolation invariant.
  'ingredient.',
  // D-169 P0 — `bridge.capabilityProfile.push` is local-bridge-only. The
  // rpc lets a paired Browser Bridge mutate the server's per-bridge
  // capability registry (`granted_origins` Slice 4's multi-bridge
  // dispatcher pre-filters on). A compromised MCP-channel agent calling
  // this could (a) shadow another bridge's capability profile to redirect
  // dispatches to itself (and thereby execute DOM ingredients against
  // origins the user never granted to the agent's bridge), or (b) zero
  // every bridge's `granted_origins` in a loop, denying service to the
  // dispatcher's eligibility filter. The server-side handler ignores
  // any caller-supplied target id and stamps the authenticated WS
  // client's `client_token_id` as the registry key, but the
  // channel-isolation gate still rejects MCP-channel invocations at the
  // dispatch layer for defense in depth. Channel-isolation invariant.
  'bridge.',
  // D-169 P1 — `system.status` is local-UI / local-bridge only. The
  // status snapshot carries the server display name + version + paired
  // client count + WS state + last-sync + recent activity counters; an
  // MCP-channel agent reading it would enumerate substrate telemetry the
  // user expects to stay local (e.g. paired client count discloses
  // device-fleet topology). The bridge's side-panel + the future
  // webclient dashboard are the only legitimate readers. The `system.`
  // prefix is reserved across the namespace so future host telemetry
  // additions (`system.healthcheck` etc.) inherit the gate.
  // Channel-isolation invariant.
  'system.',
  // D-196 S2 — Settings -> Seller overview is owner-only. It returns seller
  // tiers, customer metadata, lifecycle state, email presence, usage rollups,
  // and provider-readiness posture; an external MCP-channel agent must never
  // enumerate the seller's customer roster or monetization setup.
  'server.seller.',
  // D-178 — the `update.*` release/update rpc family is owner-only,
  // reserved out of MCP. `update.check` discloses the server's update
  // posture (current version, channel, available release, staged-rollout
  // cohort) and the later `update.{apply,rollback,set_mode}` verbs drive
  // a binary/image swap. A compromised AI agent calling any of these
  // could enumerate the fleet's version surface or (apply/rollback) push
  // an unattended binary swap / downgrade — the update boundary resolves
  // authority the way the rest of the system does: owner device surfaces
  // only, never an MCP-channel agent. Channel-isolation invariant.
  'update.',
  // D-182 §7.2 — the `cli.reachability.*` grid rpc family is owner-only,
  // reserved out of MCP. A `cli` op (whisper / docling / ffmpeg / magick /
  // codex) is connection-LESS, so it authorizes against a per-(principal ×
  // cli-ingredient × risk_tier) reachability allowlist (absent ⇒ denied) rather
  // than a connection profile; this family AUTHORS that allowlist. A compromised
  // AI agent calling `cli.reachability.set` could grant itself reachability to a
  // local binary it was never granted (then drive the now-authorized cli op
  // through the Gateway), revoke a cell a recipe depends on (DoS), and the read
  // (`list`) leaks which local tools are installed + reachable. The owner edits
  // the grid from Settings → Local tools; per-pair only, no MCP exposure.
  // Channel-isolation invariant.
  'cli.reachability.',
  // D-165 follow-on — the `collection.connection.*` rpc family is the
  // Settings → Connections surface and is operator / local-UI only. Most
  // critically, `collection.connection.{grant,revoke}OperationGroup` WIDEN a
  // connection's operation-group grants — the very surface that makes
  // write→ask reachable. A compromised MCP-channel agent calling these could
  // grant itself the `deals.write` / `contacts.write` group and then drive
  // `deal.create` / `contact.update` through the gateway, defeating D-165's
  // install-time-consent model ("recipes never construct ingredients on the
  // fly; the grant is the security boundary"). The rest of the family is
  // equally sensitive — `enroll` (attacker-controlled creds), `update` /
  // `delete` (credential tamper / DoS), `completeVendorOAuth` (OAuth code
  // injection), and the read views (`list` / `listOperationGroups`) leak
  // connection + grant topology. None is in the MCP catalog today, but the
  // reserved-prefix gate is the durable channel-isolation invariant.
  'collection.connection.',
  // D-166 override-write path — the `collection.contract.*` rpc family authors
  // user `contract.override` rows (the tightening policy layer the catalog
  // gateway reads). This is the user's restrict-what-agents-can-do surface; an
  // MCP-channel agent must NEVER write its own policy. Though the override store
  // can only TIGHTEN (the store rejects a net loosening), `deleteOverride` would
  // let a compromised agent REMOVE a user's restriction and `listOverrides`
  // leaks the user's policy posture. Operator / local-UI (Settings → Advanced)
  // only. Channel-isolation invariant.
  'collection.contract.',
  // D-211 — risk/approval replacement is an owner's global ruling about a
  // pack operation. An MCP agent may be governed by it but may never author or
  // enumerate it.
  'collection.operation.',
  // D-152 — hostname registry CRUD + ownership-proof transitions are
  // local-UI only. A compromised MCP-channel agent must never add,
  // enable, delete, or "verify" public hostnames; that would reshape
  // how visitors and paired clients reach this server. The projection
  // is secret-free, but it still leaks public reachability topology.
  // Channel-isolation invariant.
  'collection.hostname.',
  // D-201 Slice 1 — inbound webhook ingress topology, profile selection,
  // credential versions, and lifecycle are owner control-plane state. An MCP
  // agent must never enumerate public callback ids, submit/rotate signing
  // secrets, or retire an ingress. Reserve the whole namespace so future
  // profile and registration RPCs inherit the same channel isolation.
  'webhook.',
  // D-175 P5 — recued.com account ↔ server binding is operator / local-UI
  // only. `account.bind` relays a single-purpose binding token the server
  // exchanges for an identity-root credential that drives Pro cloud
  // conveniences; a compromised MCP-channel agent calling it could relay
  // an attacker-minted token to bind the server to an attacker's account
  // (then drive DDNS/ACME under that account), `account.unbind` could tear
  // down the legitimate owner's binding (DoS the Pro conveniences), and
  // `account.bindingStatus` leaks the owning account id + server identity
  // fingerprint. The token relay + bind/unbind ride the pair channel from
  // the user's own webclient; per-pair only, no MCP exposure.
  // Channel-isolation invariant.
  'account.',
  // D-175 P8 — Pro convenience status is operator-only. The
  // `pro_convenience.status` read exposes the server's Pro provisioning
  // posture (binding + entitlement + reachability gate); an MCP-channel
  // agent must never enumerate it. Channel-isolation invariant.
  'pro_convenience.',
  // D-181 slice 4 — the `execution.*` family is owner / local-UI only. The
  // live-control mutators (`execution.{kill,cancel,promote}`) drive the
  // long-op governor's queue + SIGKILL a running subprocess; a compromised
  // MCP-channel agent calling them could kill the user's running ops in a
  // loop (denial of service) or starve the queue. The reads
  // (`execution.{recent,list,get,active}`) leak run topology + the live
  // active-list — substrate the agent is deliberately UNAWARE of (D-181 §7b:
  // the agent is a *pauser*, not a *manager*). The bridge / webclient /
  // messenger renderers are the only legitimate callers; MCP is excluded by
  // construction (`LiveControlCapability: 'none'`). Channel-isolation
  // invariant. Note: this also reserves the pre-D-181 `execution.recent`
  // (D-169) + `execution.list` / `execution.get` (D-174) reads — already
  // local-UI-only by `MCP_TOOL_CATALOG` omission, now ratchet-enforced.
  'execution.',
  // Supervision feature — the `supervision.*` family enrols / flips / starts /
  // stops a long-running supervised cli daemon (cloudflared tunnel, ollama
  // serve). Owner / local-UI only: an MCP-channel agent must never take a
  // user's tunnel offline nor stand up a daemon. Channel-isolation invariant.
  'supervision.',
  // Recipe-editor authoring seam — the `recipe.*` rpc family is owner /
  // local-UI only. The read surfaces (`recipe.list` / `recipe.runnability` /
  // `recipe.pii`) already stay off MCP by `MCP_TOOL_CATALOG` omission, but the
  // authoring WRITES (`recipe.save`, and the paired `recipe.validate`) deserve
  // the stronger reserved-prefix gate: a compromised MCP-channel agent calling
  // `recipe.save` could upsert an arbitrary recipe into the per-pair store
  // (the inline save bypasses the install-time pack/connection-grant resolver;
  // D-182 — op-step recipes are now accepted, validated + runnable at dispatch,
  // so a hand-authored recipe could wire unexpected ingredient OR op flows — the
  // gate matters MORE, not less). Recipes the agent itself authors flow through
  // the MCP `recued_saveRecipe` tool (same validate + op-step-acceptance logic);
  // the local Kitchen editor is the only legitimate `recipe.*` caller.
  // Channel-isolation invariant. Reserving the whole namespace ratchet-enforces
  // the existing read-surface omissions too.
  'recipe.',
  // D-139 P5 — the `data.contact.engagements.list` WS-rpc returns the FULL
  // engagement-row shape (body_inline + vendor_raw_timestamp included) for the
  // owner's own paired clients / recipes. External MCP agents reach engagement
  // evidence ONLY through the separate `recued_contactEngagementsList` tool,
  // which projects through `projectEngagementRowForMCP` (body stripped by
  // default). Reserving the rpc prefix asserts the full-shape internal rpc can
  // never bridge onto the MCP catalog directly. Channel-isolation invariant.
  'data.contact.engagements.',
  // Accepted intake responses retain arbitrary visitor-authored values and
  // visitor identity. The paired-client Data browser may read the full shape;
  // MCP/agent access must go through an explicit future redaction + grant
  // design, never this owner-local rpc family.
  'form_response.',
  // D-172 resumable uploads — the `upload.*` control plane (create / probe /
  // finalize / delete) is the authenticated webclient owner's file-ingest
  // surface; the chunk bytes travel a dedicated binary `/ws/upload` socket, not
  // rpc. An MCP-channel agent must never drive it: `upload.create` opens
  // server-side scratch sessions (a disk-DoS lever even behind the core's caps)
  // and `upload.finalize` lands an arbitrary blob into `data.file.received`
  // (`origin: 'webclient_upload'`) — a write the owner performs from the Data →
  // File view, never an agent. Reserve the whole namespace. Channel-isolation
  // invariant.
  'upload.',
] as const;

/** Returns true iff `rpc_method_name` is reserved as local-UI-only
 *  by `MCP_RESERVED_RPC_PREFIXES`. The ratchet test uses this to
 *  assert reserved rpcs never bridge onto the MCP surface. */
export const isReservedLocalRpc = (rpc_method_name: string): boolean => {
  for (const prefix of MCP_RESERVED_RPC_PREFIXES) {
    if (rpc_method_name.startsWith(prefix)) return true;
  }
  return false;
};
