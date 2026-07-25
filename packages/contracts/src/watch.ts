/** Poll-manager / G6 — watch substrate shared types.
 *
 *  The reactive design's one NEW pull mechanism (reactive-automation-
 *  watch-dispatch design § 3): a central poll-manager that coalesces
 *  API polling by `watch_key = (connection_name, vendor_entity)` —
 *  never per-recipe, never per-field. Demand derives from enabled
 *  event-trigger rows whose pattern targets a
 *  `data.connection.api.<vendor>.<entity>.…` path; one poll loop per
 *  active key runs the connection-agnostic `<entity>.search` (full
 *  canonical projection, walk-all) through the catalog gateway,
 *  hash-diffs against a persisted snapshot, and emits per-record
 *  `created` / `updated` / `deleted` warehouse events (with
 *  `record` + `changed_fields` + `prev` riding the payload) that the
 *  existing EventTriggerDispatcher fans out.
 *
 *  Layering by fidelity (design § 2): webhook > reconciler-bus > poll.
 *  A watch key whose `(vendor, entity, connection)` already has a
 *  registered kernel reconciler (D-129 HubSpot / D-130 Salesforce) is
 *  DEFERRED — the reconciler already feeds the same logical events;
 *  the manager only spins a loop where no higher-fidelity source
 *  exists (the net-new-vendor case the poll primitive is for). */

/** Stable key for one watched `(vendor, entity, connection)` triple.
 *  Composed via `watchKeyOf` — `<vendor>/<entity>/<connection_name>`.
 *  Slash-delimited (NOT dots) so the key never collides with the
 *  dot-delimited bus-path vocabulary it coordinates. */
export type WatchKey = string;

/** Compose the canonical watch key. Segments arrive validated
 *  (`vendor` / `entity` from a parsed trigger pattern, lowercase
 *  identifiers; `connection_name` from the connection store's
 *  `[a-z0-9][a-z0-9-]*` namespace) — composition is pure string
 *  assembly. */
export const watchKeyOf = (
  vendor: string,
  entity: string,
  connection_name: string,
): WatchKey => `${vendor}/${entity}/${connection_name}`;

/** Lowercase identifier — the same grammar `composeVendorEntityScope`
 *  enforces on scope segments. A pattern segment must match this to
 *  count as a LITERAL vendor / entity (a `*` / `**` wildcard in either
 *  position is not watchable — there is no enumerable poll target). */
const SEGMENT_RE = /^[a-z][a-z0-9_]*$/;

/** Connection-name grammar (the D-125 connection store's
 *  `[a-z0-9][a-z0-9-]{0,47}` namespace) — used to recognize a LITERAL
 *  connection segment in a watch pattern. */
const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Parse an event-trigger pattern into watch demand. Returns the
 *  literal `(vendor, entity)` for a pattern shaped
 *  `data.connection.api.<vendor>.<entity>` or
 *  `data.connection.api.<vendor>.<entity>.<anything…>`, else null
 *  (non-platform-reference patterns, wildcard vendor/entity — those
 *  subscribe fine at the dispatcher but create no poll demand).
 *
 *  The emitted bus path for a platform-reference event is
 *  `data.<scope>.<connection_name>.<entity>.<kind>` with
 *  `scope = connection.api.<vendor>.<entity>` (the D-128 reconciler
 *  convention) — so a subscriber pattern's first five segments are
 *  exactly `data.connection.api.<vendor>.<entity>`, and its SIXTH
 *  segment (when present and literal — not `*` / `**`) positionally
 *  names ONE connection. A literal sixth segment NARROWS the demand to
 *  that connection (`connection_name` set), so a recipe watching one
 *  named connection never arms polls on the vendor's other
 *  connections; a wildcard sixth segment (the common `**` form) fans
 *  to every enrolled connection of the vendor. */
export const parseWatchDemandFromPattern = (
  pattern: string,
): { vendor: string; entity: string; connection_name?: string } | null => {
  const segments = pattern.split('.');
  if (segments.length < 5) return null;
  if (segments[0] !== 'data' || segments[1] !== 'connection' || segments[2] !== 'api') {
    return null;
  }
  const vendor = segments[3]!;
  const entity = segments[4]!;
  if (!SEGMENT_RE.test(vendor) || !SEGMENT_RE.test(entity)) return null;
  const sixth = segments[5];
  if (sixth !== undefined && sixth !== '*' && sixth !== '**' && CONNECTION_NAME_RE.test(sixth)) {
    return { vendor, entity, connection_name: sixth };
  }
  return { vendor, entity };
};

// ────────────────────────────────────────────────────────────────
// mcp-resource poll grammar — the 2nd WatchPollSource (mcp resource
// content polling). The connection-api source walks `<entity>.search`
// over a CRM vendor; this source reads ONE mcp resource via
// `resources/read` and diffs its content. Its watch keys + bus paths
// live in a dedicated `connection.mcp` namespace, never colliding with
// the connection-api `connection.api.*` family.
// ────────────────────────────────────────────────────────────────

/** Bus platform for mcp-resource change events — the dedicated scope
 *  the poll source emits on, distinct from the D-128 `connection.api`
 *  platform-reference family (mcp resources are not api-resident
 *  records; conflating them would let `parseWatchDemandFromPattern`
 *  mis-claim mcp patterns as connection-api demand). The emitted path
 *  is `data.connection.mcp.<connection_name>.resource.<encoded_uri>.<kind>`. */
export const MCP_RESOURCE_WATCH_PLATFORM = 'connection.mcp';

/** Sentinel `vendor` segment for mcp-resource watch keys. The universal
 *  poll-key shape is `(vendor, entity, connection)`; an mcp-resource
 *  watch maps the mcp server's connection to this vendor, the
 *  base64url-encoded resource uri to `entity`, and the connection name
 *  to `connection`. INTERNAL to the coalescing key only — the emitted
 *  bus path uses `MCP_RESOURCE_WATCH_PLATFORM`, NOT
 *  `connection.api.mcp.*` (the source supplies `event_scope` so the
 *  manager bypasses the connection.api scope composition).
 *
 *  The hyphen is LOAD-BEARING: a connection-api watch key always leads
 *  with a `SEGMENT_RE` identifier (`parseWatchDemandFromPattern` pins
 *  the pattern vendor to `/^[a-z][a-z0-9_]*$/`, hyphen-free), so a
 *  hyphenated sentinel guarantees the mcp keyspace `mcp-resource/…` can
 *  NEVER alias an api key `<vendor>/…` — even though `resolveConnectionVendor`
 *  reads a free-form `config_json.vendor` that could spell `mcp`. Two
 *  sources must mint keys in disjoint namespaces (the manager's
 *  first-claimant guard only catches same-recompute collisions; a
 *  cross-recompute ownership transfer would carry a stale snapshot). */
export const MCP_RESOURCE_WATCH_VENDOR = 'mcp-resource';

/** base64url, isomorphic across Node (Buffer) + browser (btoa/atob) —
 *  mirrors `encodeEngagementsCursor`. Unpadded url-safe base64 so the
 *  result is exactly ONE `isValidPattern` segment (`[A-Za-z0-9_-]+`). */
const b64UrlEncode = (s: string): string => {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64url');
  return globalThis
    .btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

const b64UrlDecode = (seg: string): string | null => {
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(seg, 'base64url').toString('utf8');
    const padded = seg.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(globalThis.atob(padded)));
  } catch {
    return null;
  }
};

/** Encode an mcp resource uri (carries `/`, `:`, `.`, query strings)
 *  into ONE dotted bus-path segment. The UI's "watch this resource"
 *  affordance and the poll source share this encoder so the authored
 *  pattern and the emitted path agree byte-for-byte. */
export const encodeMcpResourceUri = (uri: string): string => b64UrlEncode(uri);

/** Decode a bus-path resource segment back to its uri. Returns null for
 *  an empty / corrupt / non-canonical segment — Node's `base64url`
 *  decode is lenient, so a canonical round-trip is the real validator
 *  (rejects padded or otherwise non-`encodeMcpResourceUri` segments
 *  that would otherwise alias a different uri). */
export const decodeMcpResourceUri = (segment: string): string | null => {
  const decoded = b64UrlDecode(segment);
  if (decoded === null || decoded.length === 0) return null;
  if (b64UrlEncode(decoded) !== segment) return null;
  return decoded;
};

/** Parse an event-trigger pattern into mcp-resource watch demand.
 *  Pattern shape:
 *    `data.connection.mcp.<connection_name>.resource.<encoded_uri>[.<…>]`
 *  Returns `{ connection_name, uri }` for a LITERAL connection segment
 *  (D-125 connection-name grammar) + a LITERAL, decodable encoded-uri
 *  segment, else null — a wildcard in either position subscribes fine
 *  at the dispatcher but names no enumerable poll target (mirrors
 *  `parseWatchDemandFromPattern`'s wildcard-vendor handling). */
export const parseMcpResourceWatchDemand = (
  pattern: string,
): { connection_name: string; uri: string } | null => {
  const segments = pattern.split('.');
  if (segments.length < 6) return null;
  if (segments[0] !== 'data' || segments[1] !== 'connection' || segments[2] !== 'mcp') {
    return null;
  }
  const connection_name = segments[3]!;
  if (!CONNECTION_NAME_RE.test(connection_name)) return null;
  if (segments[4] !== 'resource') return null;
  const encoded = segments[5]!;
  if (encoded === '*' || encoded === '**') return null;
  const uri = decodeMcpResourceUri(encoded);
  if (uri === null) return null;
  return { connection_name, uri };
};

/** The mcp-resource event-path triple — a `WatchPollDemand.event_scope`
 *  override that steers the poll manager to emit on
 *  `data.connection.mcp.<connection_name>.resource.<encoded_uri>.<kind>`
 *  instead of the connection-api scope. `encoded_uri` is the
 *  `encodeMcpResourceUri` form (also the `entity` segment of the watch
 *  key) so the emitted path matches the subscriber's authored pattern. */
export const mcpResourceEventScope = (
  connection_name: string,
  encoded_uri: string,
): { platform: string; slug: string; entity_type: string } => ({
  platform: MCP_RESOURCE_WATCH_PLATFORM,
  slug: connection_name,
  entity_type: `resource.${encoded_uri}`,
});

// ────────────────────────────────────────────────────────────────
// dom poll grammar — the 3rd WatchPollSource (DOM element content
// polling via the Browser Bridge). The connection-api source walks a
// CRM vendor's `<entity>.search`; the mcp-resource source reads one mcp
// resource; this source reads ONE DOM selector's text off a matching
// browser tab (the poll "fetch" = a read-only `read_dom` dispatched to
// an eligible bridge) and content-diffs it. Its watch keys + bus paths
// live in a dedicated `dom` namespace, never colliding with
// `connection.api.*` or `connection.mcp.*`.
//
// The design doc (§ 2) classifies dom as PUSH (Bridge MutationObserver),
// but the Bridge has no persistent-observation infra (on-demand
// `executeScript` only; the MV3 service worker is ephemeral). Per the
// design's own fidelity layering (webhook > reconciler > poll), a
// dom-POLL source delivers the capability on the shipped poll-manager
// today and is transparently upgradeable to a higher-fidelity
// MutationObserver push source later — same canonical `data.dom.*`
// change key, recipe-transparent.
// ────────────────────────────────────────────────────────────────

/** Bus platform for dom change events — a dedicated family distinct
 *  from the connection.api / connection.mcp scopes. Emitted path:
 *  `data.dom.element.<encoded_target>.<kind>`. */
export const DOM_WATCH_PLATFORM = 'dom';

/** Sentinel `vendor` segment for dom watch keys. The universal poll-key
 *  shape is `(vendor, entity, connection)`; a dom watch maps the
 *  base64url-encoded (url_pattern, selector) target to `entity` and the
 *  `DOM_WATCH_CONNECTION` sentinel to `connection`. INTERNAL to the
 *  coalescing key only — the emitted bus path uses `DOM_WATCH_PLATFORM`.
 *
 *  The hyphen is LOAD-BEARING, same discipline as `MCP_RESOURCE_WATCH_VENDOR`:
 *  a connection-api watch key always leads with a `SEGMENT_RE` identifier
 *  (`parseWatchDemandFromPattern` pins the pattern vendor to
 *  `/^[a-z][a-z0-9_]*$/`, hyphen-free), so a hyphenated sentinel
 *  guarantees the dom keyspace `dom-watch/…` can NEVER alias an api key
 *  `<vendor>/…` nor the `mcp-resource/…` keyspace — the manager's
 *  first-claimant guard only catches same-recompute collisions; a
 *  cross-recompute ownership transfer would carry a stale snapshot. */
export const DOM_WATCH_VENDOR = 'dom-watch';

/** Sentinel `connection` segment for dom watch keys. A dom watch has no
 *  connection-store record — the encoded `(url_pattern, selector)` fully
 *  identifies the target, and the poll fetch fans across whichever
 *  paired bridges have a granted origin matching the url_pattern (v1
 *  binds to no specific bridge). The slot stays available for a future
 *  per-bridge binding (the design's key=(client,tab,selector)). */
export const DOM_WATCH_CONNECTION = 'bridge';

/** Encode a `(url_pattern, selector)` dom watch target into ONE dotted
 *  bus-path segment. url patterns carry `/`, `:`, `*`; selectors carry
 *  `[`, `]`, `'`, ` `, `>` — base64url of the space-joined pair rides one
 *  `isValidPattern` segment. The UI's "watch this element" affordance
 *  and the poll source share this encoder so the authored pattern and
 *  the emitted path agree byte-for-byte. */
const DOM_TARGET_SEP = String.fromCharCode(0x20); // single space (literal ' ' risks Write/Edit NUL corruption)
export const encodeDomWatchTarget = (url_pattern: string, selector: string): string =>
  b64UrlEncode(`${url_pattern}${DOM_TARGET_SEP}${selector}`);

/** Decode a dom-target segment back to its `(url_pattern, selector)`.
 *  Returns null for an empty / corrupt / non-canonical segment, or one
 *  whose decoded form lacks the separator or has an empty half — a
 *  canonical round-trip is the real validator (same posture as
 *  `decodeMcpResourceUri`). */
export const decodeDomWatchTarget = (
  segment: string,
): { url_pattern: string; selector: string } | null => {
  const decoded = b64UrlDecode(segment);
  if (decoded === null) return null;
  if (b64UrlEncode(decoded) !== segment) return null;
  const sep = decoded.indexOf(DOM_TARGET_SEP);
  // both halves must be non-empty: sep>0 (url_pattern present) and not
  // the last char (selector present).
  if (sep <= 0 || sep === decoded.length - 1) return null;
  return { url_pattern: decoded.slice(0, sep), selector: decoded.slice(sep + 1) };
};

/** Parse an event-trigger pattern into dom watch demand. Pattern shape:
 *    `data.dom.element.<encoded_target>[.<…>]`
 *  Returns `{ url_pattern, selector }` for a LITERAL, decodable target
 *  segment, else null — a wildcard subscribes fine at the dispatcher but
 *  names no enumerable poll target (mirrors the other sources' wildcard
 *  handling). `element` is the fixed marker in the slug slot so the
 *  emitted `data.dom.element.<target>.<kind>` path re-parses to the same
 *  demand a subscriber authored. */
export const parseDomWatchDemand = (
  pattern: string,
): { url_pattern: string; selector: string } | null => {
  const segments = pattern.split('.');
  if (segments.length < 4) return null;
  if (segments[0] !== 'data' || segments[1] !== 'dom' || segments[2] !== 'element') {
    return null;
  }
  const encoded = segments[3]!;
  if (encoded === '*' || encoded === '**') return null;
  return decodeDomWatchTarget(encoded);
};

/** The dom event-path triple — a `WatchPollDemand.event_scope` override
 *  steering the poll manager to emit on
 *  `data.dom.element.<encoded_target>.<kind>` instead of the
 *  connection-api scope (and so the manager never feeds the base64url
 *  `entity` to `composeVendorEntityScope`, which would throw on the
 *  non-identifier segment). `encoded_target` is the `encodeDomWatchTarget`
 *  form (also the `entity` segment of the watch key) so the emitted path
 *  matches the subscriber's authored pattern. */
export const domWatchEventScope = (
  encoded_target: string,
): { platform: string; slug: string; entity_type: string } => ({
  platform: DOM_WATCH_PLATFORM,
  slug: 'element',
  entity_type: encoded_target,
});

/** Bus-path prefix every dom-watch subscription shares
 *  (`data.dom.element.…`). The authoring + publish gates classify a
 *  trigger as a dom watch by this prefix (raw form) or the dom sugar
 *  shorthand. */
export const DOM_WATCH_BUS_PREFIX = `data.${DOM_WATCH_PLATFORM}.element.`;

/** Glob-match a pattern's post-`element` segments against the dom emit
 *  TAIL — the two fixed slots `[<any target>, 'updated']` (the dom poll
 *  source emits exactly `data.dom.element.<target>.updated`; see
 *  `ELEMENT_ON_SHORTHAND`). `*` consumes one slot, `**` zero-or-more, a
 *  literal must equal the slot value. Slot 0 (the target) accepts any
 *  single literal / `*`; slot 1 accepts only `updated` / `*`. Recursive,
 *  bounded by the 2-slot template — no allocation. Mirrors the bus
 *  matcher's `*`/`**` semantics (`@recued/warehouse-events` glob.ts; not
 *  importable from contracts). */
const domEmitTailMatches = (tail: readonly string[], ti: number, slot: number): boolean => {
  const TEMPLATE = 2; // [<target>, 'updated']
  if (ti === tail.length) return slot === TEMPLATE; // both consumed = match
  const seg = tail[ti]!;
  if (seg === '**') {
    // zero-or-more slots: try absorbing 0..(remaining) template slots.
    for (let k = slot; k <= TEMPLATE; k += 1) {
      if (domEmitTailMatches(tail, ti + 1, k)) return true;
    }
    return false;
  }
  if (slot === TEMPLATE) return false; // a single segment with no slot left
  const slotOk = slot === 0 ? true : seg === '*' || seg === 'updated';
  return slotOk && domEmitTailMatches(tail, ti + 1, slot + 1);
};

/** True when `pattern` targets the dom-element bus namespace
 *  (`data.dom.element.…`) but can NEVER match an emitted
 *  `data.dom.element.<target>.updated` event — a silently-dead
 *  subscription (the poll arms and emits, but the pattern never matches,
 *  so the recipe never fires). Catches three footguns the recipe
 *  validator rejects (the sugar form can't produce any — it always
 *  compiles a literal `.updated` tail):
 *    - tailless: `data.dom.element.<target>`, `data.dom.element.*`,
 *      `data.dom.element` (no kind position);
 *    - wrong kind: `data.dom.element.<target>.created` / `.deleted` (the
 *      source emits ONLY `updated`);
 *    - overlong: `data.dom.element.<target>.updated.extra` (the emit is
 *      exactly 5 segments).
 *
 *  DOM-ONLY by design: the dom emit is a FIXED shape
 *  (`data·dom·element·<target>·updated`), so matchability is decidable in
 *  full. The connection-api / mcp-resource emits carry a variable-length
 *  `composeVendorEntityScope` platform + multiple kinds, so the same check
 *  there would need per-namespace emit modeling — deferred (brick-2 handover). */
export const isUnmatchableDomWatchPattern = (pattern: string): boolean => {
  const segments = pattern.split('.');
  if (segments.length < 3) return false;
  if (segments[0] !== 'data' || segments[1] !== DOM_WATCH_PLATFORM || segments[2] !== 'element') {
    return false;
  }
  return !domEmitTailMatches(segments.slice(3), 0, 0);
};

/** Hard per-key poll-interval floor — 5 minutes. A poll is
 *  unconditional (unlike the demand-gated cache, whose 60 s `MIN_TTL`
 *  floor is fine): 60 s would be 1,440 API calls/day per key, so the
 *  floor sits far higher (design § 6). Matches the cron substrate's
 *  `MIN_CRON_INTERVAL_MS` posture: one floor for everyone — per the
 *  pricing positioning (Pro is friction-reduction, never a capability
 *  gate) the design's "likely Pro-gated" hedge is deliberately NOT
 *  taken. */
export const WATCH_MIN_POLL_INTERVAL_MS = 5 * 60_000;

/** Default per-key poll interval when no subscriber declares a
 *  `config_patch.watch_interval_ms` preference — 15 minutes. */
export const WATCH_DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

/** Consecutive poll failures before a watch key auto-disables (the
 *  same governance posture as the dispatcher's per-trigger error cap:
 *  fail loud in #automation, never retry-storm a broken connection).
 *  Re-enable via `watch.update {enabled: true}` — which also resets
 *  the failure counter. */
export const WATCH_ERROR_CAP = 5;

/** One watch key's merged status row — the `watch.list` wire shape.
 *  Definitional demand (subscriber triggers) ⋈ user toggle ⋈ persisted
 *  poll state ⋈ live loop roster, mirroring `AutoRunStatusEntry`'s
 *  merged-list posture. */
export interface WatchStatusEntry {
  /** `watchKeyOf(vendor, entity, connection_name)`. */
  watch_key: WatchKey;
  /** Which registered poll source owns this key (WatchSource model —
   *  design § 2 / § 9). The connection-api canonical poll is
   *  `'connection-api'`; a future cli / mcp-resource poll source mints
   *  its own id. Persisted with the state row. */
  source_id: string;
  connection_name: string;
  vendor: string;
  entity: string;
  /** User toggle (`watch.update`). Absent state row = enabled — the
   *  same absent-row-means-armed convention as auto-run settings. */
  enabled: boolean;
  /** True iff the manager currently has a live poll loop armed for
   *  this key: enabled ∧ demanded ∧ not deferred ∧ connection present. */
  active: boolean;
  /** Names the higher-fidelity source this key defers to — the manager
   *  spins no loop when set (design § 2 fidelity layering). The
   *  connection-api source defers `'reconciler'` keys (a registered
   *  kernel vendor reconciler / its webhook funnel already feeds the
   *  same events); a future poll source may defer to its own
   *  higher-fidelity twin. Null when the poll loop is the source. */
  deferred_to: string | null;
  /** Resolved interval: `min` over subscriber
   *  `config_patch.watch_interval_ms` preferences (absent → the
   *  default), floored at `WATCH_MIN_POLL_INTERVAL_MS`. */
  effective_interval_ms: number;
  /** Recipe ids of the enabled trigger rows whose patterns demand this
   *  key (the refcount, made visible — governance reads "which recipes
   *  watch this"). */
  subscriber_recipe_ids: string[];
  /** Unix-ms of the most recent completed poll (success or error).
   *  Null before the first poll. */
  last_poll_at: number | null;
  /** Outcome of the most recent poll. Null before the first. */
  last_status: 'ok' | 'error' | null;
  /** Most recent poll error message; cleared on the next success. */
  last_error: string | null;
  /** True once the baseline snapshot exists (D-124 baseline
   *  suppression: the FIRST poll persists the snapshot WITHOUT firing;
   *  diffs emit from the second poll on). Persisted — survives
   *  restart, so a restart never re-fires the world. */
  baselined: boolean;
  /** Consecutive failure count toward `WATCH_ERROR_CAP`. */
  consecutive_failures: number;
}

// ────────────────────────────────────────────────────────────────
// WatchSource model — push-source governance (design § 2 / § 9)
// ────────────────────────────────────────────────────────────────

/** The poll half's canonical source id — the connection-api canonical
 *  poll (`<entity>.search` walk-all through the catalog gateway). */
export const CONNECTION_API_POLL_SOURCE_ID = 'connection-api';

/** The 2nd poll source id — the mcp-resource poll (`resources/read` of
 *  one enrolled `connection.mcp` resource, content hash-diffed). Mints
 *  watch keys in the `mcp/<encoded_uri>/<connection>` namespace,
 *  distinct from connection-api's `<vendor>/<entity>/<connection>`
 *  keys, so the manager's first-claimant collision guard never trips
 *  between the two. */
export const MCP_RESOURCE_POLL_SOURCE_ID = 'mcp-resource';

/** The 3rd poll source id — the dom poll (`read_dom` of one selector on
 *  a bridge-served tab, content hash-diffed). Mints watch keys in the
 *  `dom-watch/<encoded_target>/bridge` namespace, distinct from both the
 *  connection-api `<vendor>/<entity>/<connection>` and mcp-resource
 *  `mcp-resource/<encoded_uri>/<connection>` keyspaces, so the manager's
 *  first-claimant collision guard never trips across the three. */
export const DOM_WATCH_POLL_SOURCE_ID = 'dom-watch';

/** Bus platform for inbound messenger user messages (D-148 P9 verified
 *  Slack / Telegram inbound, re-slotted onto the warehouse bus). Path
 *  shape: `data.messenger.<vendor>.message.created` — `slug` is the
 *  transport vendor, which by the D-163 I-4 lock-step invariant is also
 *  the `connection.notification.<name>` row name. The event `record`
 *  carries `{ from, text, vendor, connection_name, media_count }`. */
export const MESSENGER_EVENT_PLATFORM = 'messenger';

/** Bus platform for verified reception arrivals (D-149 anonymous-
 *  visitor surface, re-slotted onto the warehouse bus). Path shape:
 *  `data.reception.<endpoint_kind>.request.created` — `slug` is the
 *  endpoint kind (`intake_form` / `scheduling_link` / …). Emitted at
 *  the post-verify, pre-dispatch choke point for MUTATION actions
 *  (submit / upload / approve) — never for `view` renders. The
 *  event `record` carries only `{ endpoint_id, kind, action }`; visitor
 *  payloads stay sealed in the reception stores (PII never rides the
 *  bus). */
export const RECEPTION_EVENT_PLATFORM = 'reception';

/** Push-source mechanisms surfaced in the Automation governance list.
 *  Closed list — widen when a new push source is re-slotted under the
 *  bus (dom MutationObserver, mcp inbound, …). */
export type WatchSourceMechanism = 'webhook' | 'messenger' | 'reception';

/** One push source's governance row — the `watch.list` `sources` wire
 *  shape (the push twin of `WatchStatusEntry`). Push sources have no
 *  pause toggle here: their enablement lives at their own config
 *  boundary (webhook secret + inbound port, messenger enrollment,
 *  reception endpoint toggles) — the row reports that state instead of
 *  duplicating the switch. */
export interface WatchSourceStatusEntry {
  /** Stable row key, `<mechanism>/<instance…>` shaped (slash-delimited
   *  like `WatchKey` — never collides with bus-path dots). */
  source_key: string;
  mechanism: WatchSourceMechanism;
  /** Human row title, e.g. `hubspot webhook — my-hubspot`. */
  label: string;
  /** Bus pattern(s) this source feeds — what a subscriber recipe's
   *  `event_triggers` pattern targets. */
  emits: string[];
  /** True when the source's inbound plumbing is live end-to-end (port
   *  wired ∧ secret present / endpoint enabled / connection enrolled). */
  active: boolean;
  /** Why `active` is false, when knowable — surfaced as the row's
   *  error line in #automation. Null when active. */
  inactive_reason: string | null;
  /** Unix-ms of the last event this source emitted onto the bus.
   *  In-memory, since process start — push sources keep no persisted
   *  delivery bookkeeping. Null before the first emit. */
  last_event_at: number | null;
}
