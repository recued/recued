/** D-125 P7.2 — schema model for the per-kind enrollment forms.
 *
 *  A schema is a flat list of fields. Each field carries a dotted-path
 *  `key` describing where the value lands in the rpc payload — `name`,
 *  `display_name`, `subtype`, `config.<x>`, or `auth.<x>`. Conditional
 *  visibility (auth-type-specific fields, MCP-transport-specific
 *  fields) is encoded as a `showWhen` predicate over the live form
 *  values; the renderer evaluates it before rendering each row.
 *
 *  Pure data — schemas live in this module so the same shape feeds the
 *  Settings → Connections enrollment dialog AND any future recipe-
 *  install pre-fill that maps `vault_hints` onto the connection form. */

/** Form field types — limited closed set so the renderer can stay
 *  simple. `secret` toggles password input + autocomplete=off; `json`
 *  renders a textarea so power users can drop arbitrary structured
 *  values into per-record config (rare — most fields are single
 *  scalars). `identifier` enforces the same regex the connection-name
 *  validator applies on the rpc side. */
export type ConnectionFieldType =
  | 'identifier'
  | 'text'
  | 'secret'
  | 'url'
  | 'select'
  | 'json'
  /** A repeatable list of credential headers (1..N), anchored at the field's
   *  base `key` (e.g. `auth.headers`). Each row is a text `header_name` + a
   *  `secret` value; the flat form values use `<key>.<i>.header_name` /
   *  `<key>.<i>.value`, which the array-aware `setDeep` projects into the
   *  `auth.headers` array. The renderer shows one empty row by default + an
   *  Add/Remove affordance, capped at the contracts `MAX_HEADER_AUTH_ENTRIES`.
   *  UX only — the authoritative shape/cap/proto-guard live in the shared
   *  `validateHeaderAuthEntries` (server re-validates). */
  | 'header-list'
  /** D-192 M4c-UI — a repeatable list of messenger message→commitment TRIGGERS
   *  (`MessageMatchPattern[]`), anchored at `config.match_patterns`. Each row is
   *  a `kind` select (tag / mention / content) + a `value` + a `mode` select
   *  (content only). Flat form values use `<key>.<i>.kind` / `.value` / `.mode`.
   *  UNLIKE every other field it is NOT projected into the enroll/update
   *  `config` (the payload projector skips it): the triggers are stored via the
   *  dedicated `setMatchPatterns` merge-write (they are stripped from
   *  `ConnectionView`, so a config replace can't round-trip them) and read via
   *  `getMatchPatterns`. The submit handler saves them alongside the connection.
   *  The authoritative shape/cap/grammar lives in the contracts
   *  `validateMessageMatchPatterns` (server re-validates). */
  | 'match-pattern-list';

/** Predicate input — the form values keyed by their flat dotted path
 *  (`auth.type` → 'bearer'). The `showWhen` callback narrows visibility
 *  on these. */
export type ConnectionFormValues = Record<string, string>;

export interface ConnectionField {
  /** Dotted path into the rpc payload. Top-level keys (`name`,
   *  `display_name`, `subtype`) land at the root of the
   *  `collection.connection.enroll` args; everything under `config.*`
   *  goes into the `config` object; everything under `auth.*` goes into
   *  the `auth` object. */
  key: string;
  /** Visible label. Pure text, escaped at render time. */
  label: string;
  type: ConnectionFieldType;
  /** Static option list for `type: 'select'`. First option becomes
   *  the default selection when the form value is absent. Mutually
   *  exclusive with `options_source` — when both are set, the dynamic
   *  source wins. */
  options?: readonly string[];
  /** D-127 P4.3 — dynamic option source for `type: 'select'`. The
   *  string is a stable id the host resolves at render time
   *  (currently: `'data.mail.send_capable_instances'` — the live
   *  `collection.mail.list` filtered by `send_capable: true`).
   *  When the resolved list is empty the renderer disables the
   *  control and surfaces `emptyGuidance`. */
  options_source?: string;
  /** D-127 P4.3 — inline guidance shown under the field when its
   *  dynamic-options list resolves to empty. Used to point users at
   *  the prerequisite enrollment step (e.g. "configure SMTP for an
   *  IMAP account or grant Send permission to a Gmail / Microsoft
   *  account first"). Plain text, escaped at render time. */
  emptyGuidance?: string;
  /** Optional secondary hint shown under the input. Plain text. */
  help?: string;
  /** Placeholder for text/url/secret. */
  placeholder?: string;
  /** True -> field is rendered read-only but still projected into the
   *  rpc payload from form state. Used for provider-owned values that
   *  users may need to inspect but must not hand-edit. */
  readonly?: boolean;
  /** True -> field is not rendered but is still projected and validated
   *  from form state. Used for locked discriminators/defaults that must
   *  ride in the payload without becoming user-editable form inputs. */
  hidden?: boolean;
  /** True → field is allowed to be empty without blocking submit. */
  optional?: boolean;
  /** Visibility predicate. Returning false hides the field from the
   *  rendered form AND excludes its value from the rpc payload (so
   *  switching `auth.type` from `bearer` to `basic` doesn't smuggle
   *  the bearer token through). */
  showWhen?: (values: ConnectionFormValues) => boolean;
}

/** The probe spec is metadata only at this layer — the per-kind
 *  handler (P4.x) decides whether and how to actually probe.
 *  Surfaced so the dialog can render a "Will run probe after save"
 *  hint when the spec is present.
 *
 *  D-127 P4.3 — `kind` + `op` widen the spec for probes that don't
 *  fit the http-shaped `method` / `path` form. The email subtype
 *  uses `{ kind: 'mail', op: 'verify_send_capable' }` to signal a
 *  cross-collection probe (resolve the picked `sender_mail_instance`
 *  on `data.mail` + assert its provider's `sendCapable: true`),
 *  routed by the per-kind handler at probe time. */
export interface ConnectionProbeSpec {
  method?: string;
  path?: string;
  description?: string;
  /** Probe family. Absent = http-shaped probe (default for api / mcp /
   *  notification slack/telegram). `'mail'` = cross-collection probe
   *  against `data.mail` instance metadata. */
  kind?: 'mail';
  /** Probe operation within the named family. `'verify_send_capable'`
   *  asserts the picked mail instance's provider is send-capable. */
  op?: 'verify_send_capable';
}

export interface ConnectionSchema {
  /** Stable id matching one of the three connection kinds (api / mcp /
   *  notification). Embedded in the schema so callers can pass a
   *  schema without a separate kind argument. */
  kind: 'api' | 'mcp' | 'notification';
  /** Subtype this schema is specialized for. Notification has four;
   *  MCP has three; api has none — each subtype gets its own schema
   *  rather than smuggling subtype branches into one schema. */
  subtype?: string;
  /** Display label for the kind/subtype combination — drives the
   *  picker and the dialog header. */
  label: string;
  /** Short one-liner explaining the kind/subtype, shown under the
   *  picker option and at the top of the dialog. */
  description: string;
  fields: readonly ConnectionField[];
  probe?: ConnectionProbeSpec;
}
