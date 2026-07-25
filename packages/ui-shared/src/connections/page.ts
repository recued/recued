/** D-125 P7.1 — Settings → Connections page renderer.
 *
 *  Pure HTML — every state input arrives via `props`. The host wires
 *  `data-action` clicks to `collection.connection.list / enroll /
 *  update / delete / probe` rpcs (P2.1) and patches the page state
 *  back through.
 *
 *  Spec wireframe (D-125 § 7.1):
 *
 *    [Connections]
 *      ▼ API (4)
 *        hubspot      → app.hubapi.com           [edit] [delete] [probe]
 *        ...
 *      ▼ MCP (1)
 *        gh-mcp       → mcp.github.com/sse       [edit] [delete] [probe]
 *      ▼ Notification (3)
 *        team-slack   → #general (Slack)         [edit] [delete] [probe]
 *
 *      [+ Add Connection]
 *
 *  Add flow opens kind-picker → (optional subtype-picker) → form.
 *  Probe runs after save with result inline. Form values flow through
 *  `collection.connection.enroll` (or `update` in edit mode). */

import {
  getVendorProvider,
  vendorHasEngagement,
  MAX_HEADER_AUTH_ENTRIES,
  MESSAGE_MATCH_MAX_PATTERNS,
  validateMessageMatchPatterns,
  type BulkPackManifest,
  type ConnectionKind,
  type ConnectionVendorProvider,
  type ConnectionView,
} from '@recued/contracts';
import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { textInput, select as selectField, fieldHint } from '../primitives/field.js';
import { inlineError, inlineHint, inlineOk } from '../primitives/message.js';
import { emptyHint } from '../primitives/empty-hint.js';
import {
  CONNECTION_KIND_CHOICES,
  CONNECTION_SUBTYPE_CHOICES,
  CONNECTION_NAME_REGEX,
  collectHeaderRows,
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  isHalfFilledMatchPatternRow,
  resolveConnectionSchema,
  type ConnectionField,
  type ConnectionFormValues,
  type ConnectionSchema,
  type HeaderRow,
  type MatchPatternRow,
} from '../connection-schemas/index.js';
import {
  type ConnectionsPageState,
  type ConnectionsDialogState,
  connectionRowKey,
} from './state.js';
import { shouldPatchConnectionAuth } from './payload.js';
import {
  renderEngagementHealthPanel,
  ENGAGEMENT_HEALTH_PANEL_STYLES,
} from './engagement-health.js';
import { packsUsingConnection } from './pack-usage.js';

export interface ConnectionsPageProps extends ConnectionsPageState {
  /** Whether the host wants the page rendered as a stand-alone view
   *  (with a Back button at the top) or embedded in an outer scroll
   *  container that already has its own chrome. The sidebar mounts
   *  it as stand-alone; the options page (if it ever rehosts the
   *  page in-place post-P7.3) would mount it embedded. */
  layout?: 'standalone' | 'embedded';
  /** D-127 P4.3 / wire-up — dynamic option lists keyed by
   *  `options_source` id. Field is inherited from
   *  `ConnectionsPageState` (D-127 wire-up moved storage there so
   *  hosts hydrate via `patchConnectionsPage`); the entry on Props
   *  remains as documentation of the prop boundary. Currently
   *  populated keys: `'data.mail.send_capable_instances'` ⇒ live
   *  `collection.mail.list` filtered client-side by `send_capable:
   *  true` then projected to slugs. Missing entries resolve to `[]`
   *  and the empty-list guidance kicks in. */
}

const KIND_ORDER: readonly ConnectionKind[] = ['api', 'mcp', 'notification'];
const KIND_LABELS: Record<ConnectionKind, string> = {
  api: 'API',
  mcp: 'MCP',
  notification: 'Notification',
};

/** Group connections by their `kind`. Stable order matches KIND_ORDER. */
const groupByKind = (
  connections: readonly ConnectionView[],
): Record<ConnectionKind, ConnectionView[]> => {
  const out: Record<ConnectionKind, ConnectionView[]> = {
    api: [],
    mcp: [],
    notification: [],
  };
  for (const conn of connections) {
    out[conn.kind].push(conn);
  }
  for (const kind of KIND_ORDER) {
    out[kind].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
};

const summaryFor = (conn: ConnectionView): string => {
  if (conn.kind === 'api') {
    return typeof conn.base_url === 'string' ? conn.base_url : '';
  }
  if (conn.kind === 'mcp') {
    return typeof conn.endpoint === 'string' ? conn.endpoint : '';
  }
  if (conn.kind === 'notification') {
    if (typeof conn.channel_id === 'string') return `#${conn.channel_id}`;
    if (typeof conn.chat_id === 'string') return `chat ${conn.chat_id}`;
    // D-127 P4.3 — email subtype no longer carries SMTP creds; the
    // record's config.sender_mail_instance points at a `data.mail.<n>`
    // instance that holds the auth. Surfaces "via <slug>" so a row
    // like "newsletter via work-gmail" reads cleanly in the list.
    if (typeof conn.sender_mail_instance === 'string') return `via ${conn.sender_mail_instance}`;
    return conn.subtype ? `(${conn.subtype})` : '';
  }
  return '';
};

/** D-139 P2 / D-192 S5 — recognize a vendor connection that has an
 *  engagement-health surface so we can render the affordance. Prefer the
 *  server-stamped `supports_engagement_health` (computed from the LIVE merged
 *  vendor registry, so a pack-declared engagement CRM like Dynamics lights up
 *  too); fall back to a built-in-registry `vendorHasEngagement` read for dbless
 *  / legacy servers that don't stamp it (same graceful-degrade as
 *  `bound_pack_slugs`). The `vendor` field is `config.vendor` flattened onto
 *  the view. */
const isEngagementVendorConnection = (conn: ConnectionView): boolean => {
  if (conn.kind !== 'api') return false;
  const stamped = conn.supports_engagement_health;
  if (typeof stamped === 'boolean') return stamped;
  const v = conn.vendor;
  return typeof v === 'string' && vendorHasEngagement(v);
};

/** The connection's vendor — `config.vendor` (flattened onto the view), else
 *  the `subtype` fallback. Mirrors the server `resolveConnectionVendor` + the
 *  pack-row readiness controller, so both pivots resolve identically. */
const connectionVendor = (conn: ConnectionView): string | undefined => {
  const raw = (conn as { vendor?: unknown }).vendor;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return typeof conn.subtype === 'string' && conn.subtype.length > 0
    ? conn.subtype
    : undefined;
};

/** Connection-detail "Used by packs" — the inverse-pivot section on an api
 *  connection row: which INSTALLED packs use this connection + per-pack scope
 *  coverage (covered / missing X / not verified). Empty for non-api connections,
 *  a vendor-less connection, or when no installed pack uses it. READINESS, not
 *  a gate. */
const renderPackUsage = (
  conn: ConnectionView,
  installedManifests: readonly BulkPackManifest[],
): string => {
  if (conn.kind !== 'api') return '';
  const vendor = connectionVendor(conn);
  if (vendor === undefined) return '';
  // D-194 #6 — `bound_pack_slugs` (stamped by handleConnectionList from the grant
  // store) narrows the vendor-match to packs granted on THIS specific connection,
  // so two accounts of one vendor don't both list every vendor pack. Absent
  // (dbless / legacy) → packsUsingConnection falls back to vendor-match.
  const usage = packsUsingConnection(
    installedManifests,
    vendor,
    conn.granted_scopes,
    conn.bound_pack_slugs,
  );
  if (usage.length === 0) return '';
  const items = usage
    .map((u) => {
      const c = u.coverage;
      const status = !c.known
        ? 'scopes not verified'
        : c.covered
          ? 'covered'
          : `missing ${c.missing.join(', ')}`;
      const tone = c.known && !c.covered ? 'warn' : 'ok';
      return `<li class="connections-pack-usage-item" data-pack-usage="${e(u.pack_slug)}" data-pack-usage-tone="${tone}"><span class="connections-pack-usage-name">${e(u.pack_slug)}</span> <span class="connections-pack-usage-status">— ${e(status)}</span></li>`;
    })
    .join('');
  return `
    <div class="connections-pack-usage" data-conn-pack-usage="${e(connectionRowKey(conn.kind, conn.name))}">
      <p class="connections-pack-usage-heading">Used by packs</p>
      <ul class="connections-pack-usage-list">${items}</ul>
    </div>
  `;
};

const renderRow = (
  conn: ConnectionView,
  probeInFlight: Set<string>,
  deleteInFlight: Set<string>,
  engagementHealth: ConnectionsPageState['engagementHealth'],
  installedManifests: readonly BulkPackManifest[],
): string => {
  const key = connectionRowKey(conn.kind, conn.name);
  const probing = probeInFlight.has(key);
  const deleting = deleteInFlight.has(key);
  const showEngagement = isEngagementVendorConnection(conn);
  const engagementExpanded = showEngagement && engagementHealth.expanded.has(key);
  // D-139 P2 — render the inline engagement-health detail panel
  // beneath the row when the user has expanded it. The panel host
  // owns the rpc lifecycle; the renderer only reads state.
  const engagementPanel = engagementExpanded
    ? renderEngagementHealthPanel({
        connectionName: conn.name,
        loading: engagementHealth.loading.has(key),
        error: engagementHealth.error[key] ?? null,
        reprobing: engagementHealth.reprobing.has(key),
        installing: engagementHealth.installing.has(key),
        data: engagementHealth.data[key] ?? null,
        lastReprobe: engagementHealth.lastReprobe[key] ?? null,
      })
    : '';
  const engagementToggleLabel = engagementExpanded
    ? 'Hide health'
    : 'Engagement health';
  return `
    <div class="connections-row-wrap" data-conn-key="${e(key)}">
      <div class="connections-row" data-conn-key="${e(key)}">
        <div class="connections-row-info">
          <strong class="connections-row-name">${e(conn.name)}</strong>
          ${conn.subtype ? `<span class="connections-row-subtype">${e(conn.subtype)}</span>` : ''}
          <span class="connections-row-summary">${e(summaryFor(conn))}</span>
          <span class="connections-row-display">${e(conn.display_name)}</span>
        </div>
        <div class="connections-row-actions">
          ${
            showEngagement
              ? button({
                  label: engagementToggleLabel,
                  size: 'xs',
                  variant: engagementExpanded ? 'primary' : 'secondary',
                  action: 'connections-engagement-toggle',
                  data: { kind: conn.kind, name: conn.name },
                  disabled: deleting,
                })
              : ''
          }
          ${button({
            label: 'Edit',
            size: 'xs',
            action: 'connections-edit',
            data: { kind: conn.kind, name: conn.name },
            disabled: deleting,
          })}
          ${button({
            label: probing ? 'Probing…' : 'Probe',
            size: 'xs',
            action: 'connections-probe',
            data: { kind: conn.kind, name: conn.name },
            disabled: probing || deleting,
          })}
          ${button({
            label: deleting ? 'Deleting…' : 'Delete',
            size: 'xs',
            variant: 'danger-text',
            action: 'connections-delete',
            data: { kind: conn.kind, name: conn.name },
            disabled: deleting,
          })}
        </div>
      </div>
      ${engagementPanel}
      ${renderPackUsage(conn, installedManifests)}
    </div>
  `;
};

const renderKindGroup = (
  kind: ConnectionKind,
  rows: readonly ConnectionView[],
  probeInFlight: Set<string>,
  deleteInFlight: Set<string>,
  engagementHealth: ConnectionsPageState['engagementHealth'],
  installedManifests: readonly BulkPackManifest[],
): string => {
  if (rows.length === 0) return '';
  return `
    <section class="connections-group" data-kind="${e(kind)}">
      <h3 class="connections-group-title">${e(KIND_LABELS[kind])} (${rows.length})</h3>
      <div class="connections-group-rows">
        ${rows.map((r) => renderRow(r, probeInFlight, deleteInFlight, engagementHealth, installedManifests)).join('')}
      </div>
    </section>
  `;
};

const renderRecentProbe = (dialog: ConnectionsDialogState): string => {
  const p = dialog.recentProbe;
  if (!p) return '';
  const tone = p.status === 'ok' ? 'ok' : p.status === 'unknown' ? 'hint' : 'warn';
  const message = `Last probe for ${p.kind}/${p.name}: ${p.status}`;
  if (tone === 'ok') return inlineOk(message);
  if (tone === 'warn') return inlineError(message);
  return inlineHint(message);
};

const renderListView = (props: ConnectionsPageProps): string => {
  if (props.loading) {
    return `
      <p class="connections-loading">Loading enrolled connections…</p>
    `;
  }
  if (props.error) {
    return inlineError(props.error);
  }
  const groups = groupByKind(props.connections);
  const installedManifests = props.installedPackManifests ?? [];
  const groupBlocks = KIND_ORDER.map((kind) =>
    renderKindGroup(
      kind,
      groups[kind],
      props.probeInFlight,
      props.deleteInFlight,
      props.engagementHealth,
      installedManifests,
    ),
  ).join('');
  const empty =
    props.connections.length === 0
      ? emptyHint({
          message:
            'No connections enrolled yet. Recipes that need outbound access prompt for enrollment at install time. You can also add one ahead of time below.',
        })
      : '';
  return `
    ${renderRecentProbe(props.dialog)}
    ${empty}
    ${groupBlocks}
    <div class="connections-add-row">
      ${button({
        label: '+ Add Connection',
        variant: 'primary',
        size: 'sm',
        action: 'connections-open-add',
      })}
    </div>
  `;
};

// R13 — the per-vendor preset cards retired: one generic free-edit "Add API
// connection" form covers every vendor (any auth type, base URL, OAuth
// endpoints + scopes). Recognition / auto-detect returns later as a
// convenience pre-fill, never a gate.
const renderKindPicker = (): string => `
  <div class="connections-picker">
    <h3 class="connections-picker-title">Pick a connection kind</h3>
    <div class="connections-picker-section">
      <div class="connections-picker-grid">
        ${CONNECTION_KIND_CHOICES.map((c) => `
          <button type="button"
            class="connections-picker-card"
            data-action="connections-pick-kind"
            data-kind="${e(c.kind)}">
            <strong>${e(c.label)}</strong>
            <span class="connections-picker-card-desc">${e(c.description)}</span>
          </button>
        `).join('')}
      </div>
    </div>
    <div class="connections-dialog-actions">
      ${button({ label: 'Cancel', size: 'sm', action: 'connections-cancel-dialog' })}
    </div>
  </div>
`;

const renderSubtypePicker = (kind: 'mcp' | 'notification'): string => `
  <div class="connections-picker">
    <h3 class="connections-picker-title">Pick a ${e(KIND_LABELS[kind])} subtype</h3>
    <div class="connections-picker-grid">
      ${CONNECTION_SUBTYPE_CHOICES[kind].map((c) => `
        <button type="button"
          class="connections-picker-card"
          data-action="connections-pick-subtype"
          data-subtype="${e(c.subtype)}">
          <strong>${e(c.label)}</strong>
          <span class="connections-picker-card-desc">${e(c.description)}</span>
        </button>
      `).join('')}
    </div>
    <div class="connections-dialog-actions">
      ${button({ label: 'Back', size: 'sm', action: 'connections-back-to-kind' })}
      ${button({ label: 'Cancel', size: 'sm', action: 'connections-cancel-dialog' })}
    </div>
  </div>
`;

const fieldId = (key: string): string => `conn-field-${key.replace(/\./g, '-')}`;

/** D-127 P4.3 — resolve the option list for a select field. Static
 *  `field.options` and dynamic `field.options_source` are mutually
 *  exclusive in spec; when both are set the dynamic source wins so a
 *  schema migration can't accidentally surface stale static defaults.
 *  Returns the list + an `isDynamic` flag the renderer uses to decide
 *  whether to surface the empty-guidance + disabled-control UX. */
const resolveSelectOptions = (
  field: ConnectionField,
  dynamicOptions: Record<string, readonly string[]> | undefined,
): { options: readonly string[]; isDynamic: boolean } => {
  if (field.options_source) {
    const list = dynamicOptions?.[field.options_source] ?? [];
    return { options: list, isDynamic: true };
  }
  return { options: field.options ?? [], isDynamic: false };
};

/** One row of a `header-list` field — a `header_name` text input + a `value`
 *  secret input + a Remove button. The inputs carry `data-conn-field` so the
 *  host's delegated input listener syncs them like every other field; Remove is
 *  a `data-action`. `position` is the 1-based display order; `total` gates the
 *  Remove button so the last row can't be removed (one row always stays). */
const renderHeaderRow = (
  baseKey: string,
  row: HeaderRow,
  position: number,
  total: number,
  saving: boolean,
): string => {
  const nameKey = `${baseKey}.${row.index}.header_name`;
  const valueKey = `${baseKey}.${row.index}.value`;
  const nameInput = textInput({
    id: fieldId(nameKey),
    type: 'text',
    value: row.header_name,
    placeholder: 'X-API-Key',
    spellcheck: false,
    disabled: saving,
    ariaLabel: `Header ${position} name`,
    data: { 'conn-field': nameKey },
    extraClass: 'connections-header-name',
  });
  const valueInput = textInput({
    id: fieldId(valueKey),
    type: 'password',
    value: row.value,
    autocomplete: 'off',
    spellcheck: false,
    disabled: saving,
    ariaLabel: `Header ${position} value`,
    data: { 'conn-field': valueKey },
    extraClass: 'connections-header-value',
  });
  const removeBtn = button({
    label: 'Remove',
    action: 'connections-remove-header',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-header-remove',
    disabled: saving || total <= 1,
    ariaLabel: `Remove header ${position}`,
    data: { 'header-index': String(row.index), 'base-key': baseKey },
  });
  return `<div class="connections-header-row" data-header-row="${row.index}">${nameInput}${valueInput}${removeBtn}</div>`;
};

/** Render a `header-list` field — the repeatable 1..N credential-header rows +
 *  an "Add header" button (disabled at `MAX_HEADER_AUTH_ENTRIES`). Defaults to
 *  one empty row. UX only; the server re-validates via `validateHeaderAuthEntries`. */
const renderHeaderList = (
  field: ConnectionField,
  values: ConnectionFormValues,
  saving: boolean,
): string => {
  const collected = collectHeaderRows(values, field.key);
  const rows: HeaderRow[] =
    collected.length > 0 ? collected : [{ index: 0, header_name: '', value: '' }];
  const rowsHtml = rows
    .map((r, i) => renderHeaderRow(field.key, r, i + 1, rows.length, saving))
    .join('');
  const addBtn = button({
    label: '+ Add header',
    action: 'connections-add-header',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-header-add',
    disabled: saving || rows.length >= MAX_HEADER_AUTH_ENTRIES,
    data: { 'base-key': field.key },
  });
  const required = field.optional ? '' : ' <span class="connections-field-required">*</span>';
  const hint = field.help ? fieldHint(field.help) : '';
  return `
    <div class="connections-field-row connections-header-list" data-field-key="${e(field.key)}">
      <label>${e(field.label)}${required}</label>
      <div class="connections-header-rows">${rowsHtml}</div>
      ${addBtn}
      ${hint}
    </div>
  `;
};

// D-192 M4c-UI — messenger trigger editor. Kind + mode option lists (a leading
// placeholder on kind so an untouched row carries no kind — the validator flags
// a value-without-kind rather than silently dropping it).
const MATCH_KIND_OPTIONS = [
  { value: '', label: 'Trigger on…' },
  { value: 'tag', label: '#tag' },
  { value: 'mention', label: '@mention' },
  { value: 'content', label: 'Keyword text' },
];
const MATCH_MODE_OPTIONS = [
  { value: 'contains', label: 'Anywhere' },
  { value: 'word', label: 'Whole word' },
];

/** One trigger row — a `kind` select + a `value` input + (content only) a
 *  `mode` select + Remove. Keyed `<base>.<i>.kind` / `.value` / `.mode`. */
const renderMatchPatternRow = (
  baseKey: string,
  row: MatchPatternRow,
  position: number,
  total: number,
  saving: boolean,
): string => {
  const kindKey = `${baseKey}.${row.index}.kind`;
  const valueKey = `${baseKey}.${row.index}.value`;
  const modeKey = `${baseKey}.${row.index}.mode`;
  const kindSelect = selectField({
    id: fieldId(kindKey),
    options: MATCH_KIND_OPTIONS.map((o) => ({ ...o, selected: o.value === row.kind })),
    disabled: saving,
    ariaLabel: `Trigger ${position} type`,
    data: { 'conn-field': kindKey },
    extraClass: 'connections-matchpattern-kind',
  });
  const valuePlaceholder =
    row.kind === 'content' ? 'e.g. I will send' : row.kind === 'mention' ? 'handle or user id' : 'commit';
  const valueInput = textInput({
    id: fieldId(valueKey),
    type: 'text',
    value: row.value,
    placeholder: valuePlaceholder,
    spellcheck: false,
    disabled: saving,
    ariaLabel: `Trigger ${position} value`,
    data: { 'conn-field': valueKey },
    extraClass: 'connections-matchpattern-value',
  });
  // The mode sub-control rides ONLY a content row.
  const modeSelect =
    row.kind === 'content'
      ? selectField({
          id: fieldId(modeKey),
          options: MATCH_MODE_OPTIONS.map((o) => ({ ...o, selected: o.value === (row.mode || 'contains') })),
          disabled: saving,
          ariaLabel: `Trigger ${position} match mode`,
          data: { 'conn-field': modeKey },
          extraClass: 'connections-matchpattern-mode',
        })
      : '';
  const removeBtn = button({
    label: 'Remove',
    action: 'connections-remove-pattern',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-matchpattern-remove',
    disabled: saving || total <= 1,
    ariaLabel: `Remove trigger ${position}`,
    data: { 'pattern-index': String(row.index), 'base-key': baseKey },
  });
  return `<div class="connections-matchpattern-row" data-pattern-row="${row.index}">${kindSelect}${valueInput}${modeSelect}${removeBtn}</div>`;
};

/** Render a `match-pattern-list` field — the repeatable trigger rows + an "Add
 *  trigger" button (capped at `MESSAGE_MATCH_MAX_PATTERNS`). Defaults to one
 *  empty row (an empty list = no triggers, which is valid). Saved via
 *  `setMatchPatterns`, NOT this form's config. */
const renderMatchPatternList = (
  field: ConnectionField,
  values: ConnectionFormValues,
  saving: boolean,
): string => {
  const collected = collectMatchPatternRows(values, field.key);
  const rows: MatchPatternRow[] =
    collected.length > 0 ? collected : [{ index: 0, kind: '', value: '', mode: '' }];
  const rowsHtml = rows
    .map((r, i) => renderMatchPatternRow(field.key, r, i + 1, rows.length, saving))
    .join('');
  const addBtn = button({
    label: '+ Add trigger',
    action: 'connections-add-pattern',
    size: 'sm',
    variant: 'secondary',
    extraClass: 'connections-matchpattern-add',
    disabled: saving || rows.length >= MESSAGE_MATCH_MAX_PATTERNS,
    data: { 'base-key': field.key },
  });
  const hint = field.help ? fieldHint(field.help) : '';
  return `
    <div class="connections-field-row connections-matchpattern-list" data-field-key="${e(field.key)}">
      <label>${e(field.label)}</label>
      <div class="connections-matchpattern-rows">${rowsHtml}</div>
      ${addBtn}
      ${hint}
    </div>
  `;
};

const renderField = (
  field: ConnectionField,
  values: ConnectionFormValues,
  dynamicOptions: Record<string, readonly string[]> | undefined,
  mode: ConnectionsDialogState['mode'],
  // D-165 P3.enroll-host — disable every control while a submit is committing
  // so the user can't type into a form whose values the rpc already carries
  // (the edit would otherwise be silently dropped / erased on a failed retry).
  saving = false,
): string => {
  if (field.hidden) return '';
  if (field.showWhen && !field.showWhen(values)) return '';
  // A `header-list` renders its own repeatable-rows block, not the standard
  // single label+control wrapper.
  if (field.type === 'header-list') return renderHeaderList(field, values, saving);
  // A `match-pattern-list` (D-192 M4c-UI) likewise renders its own repeatable
  // trigger-rows block.
  if (field.type === 'match-pattern-list') return renderMatchPatternList(field, values, saving);
  const id = fieldId(field.key);
  const value = values[field.key] ?? '';
  let control: string;
  let dynamicEmptyHint = '';
  if (field.type === 'select') {
    const { options: optList, isDynamic } = resolveSelectOptions(field, dynamicOptions);
    const isEmpty = isDynamic && optList.length === 0;
    const renderedOpts = isEmpty
      ? [{
          // Empty placeholder — shown alongside the disabled select so
          // the user sees something rather than an empty dropdown that
          // looks broken. The submit-disable + emptyGuidance below
          // explain why the picker is empty.
          value: '',
          label: '— no options available —',
          selected: true,
          disabled: true,
        }]
      : [
          ...(isDynamic && value === ''
            ? [{
                value: '',
                label: '— select —',
                selected: true,
                disabled: true,
              }]
            : []),
          ...optList.map((opt) => ({
            value: opt,
            label: opt,
            selected: opt === (value || (!isDynamic ? optList[0] || '' : '')),
          })),
        ];
    control = selectField({
      id,
      data: { 'conn-field': field.key },
      options: renderedOpts,
      disabled: isEmpty || field.readonly || saving,
    });
    if (isEmpty && field.emptyGuidance) {
      dynamicEmptyHint = `<p class="rx-msg rx-msg-warn connections-field-empty-guidance" role="alert">${e(field.emptyGuidance)}</p>`;
    }
  } else if (field.type === 'json') {
    control = `
      <textarea
        id="${e(id)}"
        class="rx-input connections-field-json"
        data-conn-field="${e(field.key)}"
        rows="3"
        spellcheck="false"
        placeholder="${e(field.placeholder ?? '')}"
        ${field.readonly || saving ? 'readonly' : ''}
      >${e(value)}</textarea>
    `;
  } else {
    const inputType =
      field.type === 'secret'
        ? 'password'
        : field.type === 'url'
          ? 'url'
          : 'text';
    control = textInput({
      id,
      type: inputType,
      value,
      placeholder: field.placeholder,
      autocomplete: field.type === 'secret' ? 'off' : undefined,
      // D-165 P3.path-picker — `subresource_path` joins `name` as an
      // identity-fixed field: editable on create, read-only in edit (the
      // scope is immutable post-enrollment; re-scope = new connection).
      readonly:
        field.readonly ||
        saving ||
        (mode === 'edit' && (field.key === 'name' || field.key === 'subresource_path')),
      spellcheck: false,
      data: { 'conn-field': field.key },
    });
  }
  const required = field.optional ? '' : ' <span class="connections-field-required">*</span>';
  const hint = field.help ? fieldHint(field.help) : '';
  return `
    <div class="connections-field-row" data-field-key="${e(field.key)}">
      <label for="${e(id)}">${e(field.label)}${required}</label>
      ${control}
      ${hint}
      ${dynamicEmptyHint}
    </div>
  `;
};

/** Validate a connection enrollment / edit form. Returns the first
 *  human-readable error message, or `null` when the form is submittable.
 *  Exported (D-165 P3.enroll-host) so the webclient enrollment host can
 *  gate its Submit imperatively + re-check before firing `enroll` /
 *  `update` with the SAME rule the renderer disables the button on — the
 *  renderer and the host agree on validity by construction. */
export const validateConnectionForm = (
  schema: ConnectionSchema,
  values: ConnectionFormValues,
  dynamicOptions: Record<string, readonly string[]> | undefined,
  mode: ConnectionsDialogState['mode'],
): string | null => {
  const name = values.name?.trim() ?? '';
  if (!name) return 'Name is required.';
  if (mode === 'create' && !CONNECTION_NAME_REGEX.test(name)) {
    return 'Name must be lowercase letters, digits, or dashes (1–48 chars).';
  }
  const display = values.display_name?.trim() ?? '';
  if (!display) return 'Display name is required.';
  const authPatchIntent = mode === 'edit'
    ? shouldPatchConnectionAuth(schema, values)
    : true;
  for (const field of schema.fields) {
    if (field.showWhen && !field.showWhen(values)) continue;
    if (mode === 'edit' && !authPatchIntent && field.key.startsWith('auth.')) continue;
    // D-127 P4.3 — dynamic-options select with an empty resolved list
    // can never be satisfied; surface the field's emptyGuidance so the
    // user sees a single coherent message at the form level (instead
    // of generic "Field is required" + the inline guidance).
    if (field.type === 'select' && field.options_source) {
      const list = dynamicOptions?.[field.options_source] ?? [];
      if (list.length === 0 && !field.optional) {
        return field.emptyGuidance
          ?? `${field.label}: no options available — configure a prerequisite first.`;
      }
      // D-165 P3 — a dynamic select must be SELECTED FROM its live list: a
      // non-empty value that isn't a current option is stale (e.g. an account
      // that lost send capability, a deleted instance, or an edit-prefilled
      // value the refreshed list dropped). Reject it so a stale binding can
      // never be saved. An empty value falls through to the required-field
      // check below (or is allowed when the field is optional).
      const selected = values[field.key]?.trim() ?? '';
      if (selected.length > 0 && !list.includes(selected)) {
        return `${field.label}: "${selected}" is no longer available — pick one of the listed options.`;
      }
    }
    // header-list — a repeatable credential-header group. Each non-blank row
    // needs BOTH a name and a value (a half-filled row is an error); at least
    // one complete row is required unless the field is optional. UX only — the
    // server re-validates the shape (+ cap + proto-guard) via
    // `validateHeaderAuthEntries`, so this never diverges from that authority.
    if (field.type === 'header-list') {
      let complete = 0;
      for (const row of collectHeaderRows(values, field.key)) {
        const hasName = row.header_name.trim().length > 0;
        const hasValue = row.value.trim().length > 0;
        if (hasName !== hasValue) {
          return `${field.label}: each header needs both a name and a value.`;
        }
        if (hasName) complete += 1;
      }
      if (!field.optional && complete === 0) {
        return `${field.label}: add at least one header (name and value).`;
      }
      continue;
    }
    // match-pattern-list (D-192 M4c-UI) — a repeatable messenger trigger group.
    // A half-filled row (a kind with no value, or a value with no kind) is an
    // error; the complete rows are then re-checked against the SAME contracts
    // rule the server enforces on `setMatchPatterns` (token grammar / cap), so
    // the two never diverge. An empty list is valid (no triggers).
    if (field.type === 'match-pattern-list') {
      const rows = collectMatchPatternRows(values, field.key);
      for (const row of rows) {
        if (isHalfFilledMatchPatternRow(row)) {
          return `${field.label}: each trigger needs both a type and a value.`;
        }
      }
      const problems = validateMessageMatchPatterns(matchPatternRowsToPatterns(rows));
      if (problems.length > 0) return `${field.label}: ${problems[0]}`;
      continue;
    }
    if (field.optional) continue;
    const raw = values[field.key] ?? '';
    if (raw.trim().length === 0) {
      return `${field.label} is required.`;
    }
  }
  return null;
};

/** D-129 P1.3 — render the OAuth dance affordance for vendor flows.
 *  Surfaces three states inline above the Save button:
 *   - idle (no refresh_token yet): primary "Authorize with <Vendor>"
 *     button. Click is captured by the host, which runs the OAuth
 *     dance + calls `collection.connection.completeVendorOAuth` + patches
 *     `auth.refresh_token` + `oauthGrantedScopes` back into state.
 *   - in flight (`oauthInFlight: true`): button replaced by a
 *     disabled "Authorizing…" pill so the user knows the popup /
 *     web-auth flow is mid-roundtrip.
 *   - completed (refresh_token populated): re-authorize affordance
 *     (smaller, secondary) + a granted-scopes summary so the user
 *     sees what the vendor consented to before Save.
 *   - error: an inline error message above the button surfaces
 *     `oauthError` (rpc rejection, popup blocked, user denied
 *     consent). */
const renderVendorOAuth = (dialog: ConnectionsDialogState): string => {
  // Render the in-app consent affordance for a registered vendor flow OR a
  // generic `api` oauth2_refresh form (R14 — any BYO vendor). On the generic
  // form the button is an OPTIONAL accelerator: the paste-a-refresh-token field
  // sits below, and the host validates the typed authorize/token URLs on click.
  const isGeneric =
    !dialog.vendor
    && dialog.kind === 'api'
    && dialog.values['auth.type'] === 'oauth2_refresh';
  const isRegisteredRefreshFlow =
    dialog.vendor !== null
    && dialog.values['auth.type'] === 'oauth2_refresh';
  if (!isRegisteredRefreshFlow && !isGeneric) return '';
  const refreshToken = (dialog.values['auth.refresh_token'] ?? '').trim();
  const hasToken = refreshToken.length > 0;
  const grantedScopes = dialog.oauthGrantedScopes ?? [];
  const grantedSummary = grantedScopes.length > 0
    ? `<p class="connections-oauth-scopes">Granted scopes (${grantedScopes.length}): ${e(grantedScopes.join(', '))}</p>`
    : '';
  const errorBlock = dialog.oauthError ? inlineError(`OAuth: ${dialog.oauthError}`) : '';
  const who = dialog.vendor
    ? vendorDisplayName(dialog.vendor, getVendorProvider(dialog.vendor))
    : null;
  const buttonLabel = dialog.oauthInFlight
    ? 'Authorizing…'
    : hasToken
      ? (who ? `Re-authorize with ${who}` : 'Re-authorize')
      : (who ? `Authorize with ${who}` : 'Authorize');
  return `
    <div class="connections-oauth"${dialog.vendor ? ` data-vendor="${e(dialog.vendor)}"` : ''}>
      ${errorBlock}
      ${grantedSummary}
      ${button({
        label: buttonLabel,
        variant: hasToken && !dialog.oauthInFlight ? 'secondary' : 'primary',
        size: 'sm',
        action: 'connections-authorize-vendor',
        ...(dialog.vendor ? { data: { vendor: dialog.vendor } } : {}),
        disabled: dialog.oauthInFlight,
      })}
    </div>
  `;
};

const vendorDisplayName = (
  vendor: string,
  provider: ConnectionVendorProvider | null,
): string => provider?.display_name ?? vendor;

const renderVendorConsentDisclosure = (dialog: ConnectionsDialogState): string => {
  if (!dialog.vendor) return '';
  const provider = getVendorProvider(dialog.vendor);
  const label = vendorDisplayName(dialog.vendor, provider);
  if (provider === null) {
    return `
      <div class="connections-consent" data-vendor="${e(dialog.vendor)}">
        <h4 class="connections-consent-title">Connection consent</h4>
        <p class="connections-consent-note">Vendor enrollment metadata is unavailable for ${e(dialog.vendor)}.</p>
      </div>
    `;
  }

  const requestedScopes = provider.oauth.scopes
    .map((scope) => `<li><code>${e(scope)}</code></li>`)
    .join('');
  const hasToken = (dialog.values['auth.refresh_token'] ?? '').trim().length > 0;
  const vendorStateKind = dialog.saving
    ? 'saving_connection'
    : hasToken
      ? 'ready_after_auth'
      : 'needs_connection';
  const vendorStateLabel = dialog.saving
    ? 'Saving connection before vendor setup'
    : hasToken
      ? 'Ready for provider-side setup after Save'
      : `Needs ${label} OAuth consent`;
  const vendorStateDetail = dialog.saving
    ? 'Provider-side setup remains held until the connection credential is persisted.'
    : hasToken
      ? `Provider-side setup can use the saved connection token. Default reconciliation cadence: ${provider.default_cadence}.`
      : 'Provider-side setup is held until OAuth completes and the connection is saved.';

  return `
    <div class="connections-consent" data-vendor="${e(dialog.vendor)}">
      <h4 class="connections-consent-title">Connection consent</h4>
      <p class="connections-consent-note">${e(label)} will request these OAuth scopes before the connection is saved.</p>
      <ul class="connections-consent-scopes">
        ${requestedScopes}
      </ul>
      <div class="connections-vendor-state" data-vendor-state="${e(vendorStateKind)}">
        <strong>${e(vendorStateLabel)}</strong>
        <span>${e(vendorStateDetail)}</span>
      </div>
    </div>
  `;
};

const renderForm = (
  dialog: ConnectionsDialogState,
  dynamicOptions: Record<string, readonly string[]> | undefined,
): string => {
  const kind = dialog.kind;
  if (!kind) {
    return inlineError('Connection kind missing — pick a kind to continue.');
  }
  const schema = resolveConnectionSchema(
    kind,
    dialog.subtype ?? undefined,
    dialog.vendor ?? undefined,
  );
  if (!schema) {
    return inlineError(
      `No schema for ${kind}${dialog.subtype ? `/${dialog.subtype}` : ''} — pick a different subtype.`,
    );
  }
  const formError = dialog.error ?? validateConnectionForm(
    schema,
    dialog.values,
    dynamicOptions,
    dialog.mode,
  );
  const probeNote = schema.probe
    ? fieldHint(
        schema.probe.description ??
          (schema.probe.kind && schema.probe.op
            ? `After save, a probe runs (${schema.probe.kind}.${schema.probe.op}) to verify the binding.`
            : `After save, a probe runs (${schema.probe.method ?? 'kind-specific'}${schema.probe.path ? ' ' + schema.probe.path : ''}) to verify the credentials.`),
      )
    : '';
  // D-129 P1.3 — vendor flows skip subtype-picker (vendors are always
  // kind=api). The Back affordance therefore points back to the
  // kind-picker, regardless of `kind`. Bare-kind forms keep the
  // existing kind=api → kind-picker, kind=mcp/notification →
  // subtype-picker mapping.
  const backAction = dialog.vendor
    ? 'connections-back-to-kind'
    : kind === 'api'
      ? 'connections-back-to-kind'
      : 'connections-back-to-subtype';
  return `
    <div class="connections-form" data-stage="form"${dialog.vendor ? ` data-vendor="${e(dialog.vendor)}"` : ''}>
      <h3 class="connections-form-title">
        ${e(dialog.mode === 'edit' ? 'Edit ' : 'Add ')}${e(schema.label)}
      </h3>
      <p class="connections-form-description">${e(schema.description)}</p>
      ${probeNote}
      ${renderVendorOAuth(dialog)}
      ${renderVendorConsentDisclosure(dialog)}
      <div class="connections-form-fields">
        ${schema.fields.map((f) => renderField(f, dialog.values, dynamicOptions, dialog.mode, dialog.saving)).join('')}
      </div>
      ${dialog.error ? inlineError(dialog.error) : ''}
      <div class="connections-dialog-actions">
        ${dialog.mode === 'create'
          ? button({
              label: 'Back',
              size: 'sm',
              action: backAction,
            })
          : ''}
        ${button({ label: 'Cancel', size: 'sm', action: 'connections-cancel-dialog' })}
        ${button({
          label: dialog.saving
            ? 'Saving…'
            : dialog.mode === 'edit'
              ? 'Save changes'
              : 'Save and probe',
          variant: 'primary',
          size: 'sm',
          action: 'connections-submit-form',
          disabled: dialog.saving || (formError !== null && !dialog.error),
        })}
      </div>
    </div>
  `;
};

const renderDialog = (props: ConnectionsPageProps): string => {
  const d = props.dialog;
  if (d.stage === 'closed') return '';
  let body = '';
  if (d.stage === 'kind-picker') body = renderKindPicker();
  else if (d.stage === 'subtype-picker') {
    if (d.kind === 'mcp' || d.kind === 'notification') {
      body = renderSubtypePicker(d.kind);
    } else {
      body = inlineError('Subtype picker requested for a kind without subtypes.');
    }
  } else if (d.stage === 'form') body = renderForm(d, props.dynamicOptions);
  return `
    <div class="connections-dialog" role="dialog" aria-label="Connection enrollment">
      ${body}
    </div>
  `;
};

const renderHeader = (props: ConnectionsPageProps): string => {
  if (props.layout === 'embedded') return '';
  return `
    <header class="connections-page-header">
      <button type="button"
        class="rx-btn rx-btn-link rx-btn-sm btn btn-link btn-sm"
        data-action="connections-close-page">
        ← Settings
      </button>
      <h2 class="connections-page-title">Connections</h2>
      <p class="connections-page-subtitle">
        Outbound endpoints recipes use — HTTP APIs, MCP servers, and notification destinations.
      </p>
    </header>
  `;
};

/** D-192 slice 5 — the delete-confirm modal. Renders over the list when a Delete
 *  click is awaiting confirmation. The "also remove the [N] item(s)" checkbox
 *  appears ONLY when the `previewPurge` count resolved to > 0 (a `null` count —
 *  still loading, caller unwired, or a non-purgeable connection — or a 0 count
 *  render a plain confirm: the connection is removed, its synced data kept). */
const renderDeleteConfirm = (props: ConnectionsPageProps): string => {
  const dc = props.deleteConfirm;
  if (dc === null) return '';
  const showOptIn = typeof dc.count === 'number' && dc.count > 0;
  const optInBlock = showOptIn
    ? `
        <label class="connections-delete-optin">
          <input type="checkbox" data-action="connections-delete-toggle-mirror"${
            dc.removeMirror ? ' checked' : ''
          }${dc.deleting ? ' disabled' : ''} />
          <span>Also remove the ${dc.count} item${
            dc.count === 1 ? '' : 's'
          } this connection synced to your warehouse</span>
        </label>
        <p class="connections-delete-note">
          Deletes the mirrored records this connection created. Your account and its
          activity history are kept.
        </p>`
    : '';
  const body = showOptIn
    ? 'Remove this connection. Its synced data is kept unless you opt in below.'
    : 'Remove this connection. Its synced data is kept.';
  return `
    <div class="connections-delete-backdrop">
      <div class="connections-delete-confirm" role="dialog" aria-modal="true"
           aria-label="Remove connection ${e(dc.name)}">
        <h3 class="connections-delete-title">Remove ${e(dc.name)}?</h3>
        <p class="connections-delete-body">${body}</p>
        ${optInBlock}
        <div class="connections-delete-actions">
          ${button({
            label: 'Cancel',
            size: 'sm',
            action: 'connections-delete-cancel',
            disabled: dc.deleting,
          })}
          ${button({
            label: dc.deleting ? 'Removing…' : 'Remove',
            size: 'sm',
            variant: 'danger',
            action: 'connections-delete-confirm',
            data: { kind: dc.kind, name: dc.name },
            disabled: dc.deleting,
          })}
        </div>
      </div>
    </div>
  `;
};

export const renderConnectionsPage = (props: ConnectionsPageProps): string => {
  const dialogOpen = props.dialog.stage !== 'closed';
  return `
    <div class="connections-page${dialogOpen ? ' connections-page--dialog-open' : ''}">
      ${renderHeader(props)}
      ${dialogOpen ? renderDialog(props) : renderListView(props)}
      ${dialogOpen ? '' : renderDeleteConfirm(props)}
    </div>
  `;
};

/** Self-contained CSS — same convention as every primitive
 *  (`.connections-*` selectors only, no ancestor coupling). The
 *  options-page + sidebar both already include the primitive
 *  stylesheet so we only add page-specific rules here. */
export const CONNECTIONS_PAGE_STYLES = `
.connections-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}
.connections-page-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-page-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.connections-page-subtitle {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.connections-loading {
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.connections-group-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin: 0 0 4px;
}
.connections-group-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-pack-usage {
  margin: 4px 0 2px 12px;
  padding-top: 4px;
  border-top: 1px solid var(--border, #e5e5e5);
}
.connections-pack-usage-heading {
  margin: 0 0 2px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
}
.connections-pack-usage-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.connections-pack-usage-item {
  font-size: 12px;
}
.connections-pack-usage-name { font-weight: 600; }
.connections-pack-usage-status { color: var(--fg-muted); }
.connections-pack-usage-item[data-pack-usage-tone="warn"] .connections-pack-usage-status {
  color: var(--danger, #b3261e);
}
.connections-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
.connections-row-info {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.connections-row-name {
  font-size: 13px;
  color: var(--fg);
}
.connections-row-subtype {
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: lowercase;
}
.connections-row-summary {
  font-size: 12px;
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.connections-row-display {
  font-size: 11px;
  color: var(--fg-muted);
}
.connections-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.connections-add-row {
  display: flex;
  justify-content: flex-start;
  margin-top: 8px;
}
.connections-dialog {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  background: var(--bg);
}
.connections-picker-title,
.connections-form-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.connections-form-description {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 12px;
}
.connections-picker-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.connections-picker-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.connections-picker-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--fg-muted);
  margin: 0;
}
.connections-picker-section-hint {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 4px;
}
.connections-picker-card {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
  font-family: inherit;
  color: var(--fg);
}
.connections-picker-card:hover { background: var(--surface-sunk); }
.connections-picker-card--vendor {
  border-color: var(--accent, var(--border));
}
.connections-picker-card-desc {
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-oauth {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-sunk);
  margin-bottom: 12px;
}
.connections-oauth-scopes {
  font-size: 11px;
  color: var(--fg-muted);
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  word-break: break-all;
}
.connections-consent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  margin-bottom: 12px;
}
.connections-consent-title {
  font-size: 12px;
  font-weight: 600;
  margin: 0;
}
.connections-consent-note {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.connections-consent-scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}
.connections-consent-scopes code {
  display: inline-block;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-sunk);
  font-size: 11px;
}
.connections-vendor-state {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.connections-vendor-state strong {
  font-weight: 600;
}
.connections-vendor-state span {
  color: var(--fg-muted);
}
.connections-form-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}
.connections-field-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.connections-field-row label {
  font-size: 12px;
  font-weight: 500;
}
.connections-field-required {
  color: var(--danger);
  font-weight: 600;
}
.connections-field-json {
  resize: vertical;
  min-height: 60px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.connections-header-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.connections-header-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.connections-header-row .connections-header-name { flex: 1 1 40%; }
.connections-header-row .connections-header-value { flex: 1 1 60%; }
.connections-header-row .connections-header-remove { flex: 0 0 auto; }
.connections-header-add { margin-top: 6px; align-self: flex-start; }
.connections-matchpattern-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.connections-matchpattern-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.connections-matchpattern-row .connections-matchpattern-kind { flex: 0 0 auto; }
.connections-matchpattern-row .connections-matchpattern-value { flex: 1 1 40%; min-width: 120px; }
.connections-matchpattern-row .connections-matchpattern-mode { flex: 0 0 auto; }
.connections-matchpattern-row .connections-matchpattern-remove { flex: 0 0 auto; margin-left: auto; }
.connections-matchpattern-add { margin-top: 6px; align-self: flex-start; }
.connections-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.connections-row-wrap {
  display: flex;
  flex-direction: column;
}
.connections-delete-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.45);
}
.connections-delete-confirm {
  width: 100%;
  max-width: 380px;
  padding: 20px;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: var(--fg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
}
.connections-delete-title { margin: 0 0 8px; font-size: 15px; }
.connections-delete-body { margin: 0 0 12px; font-size: 13px; color: var(--fg-muted); }
.connections-delete-optin {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.connections-delete-optin input { margin-top: 2px; }
.connections-delete-note {
  margin: 6px 0 0 24px;
  font-size: 12px;
  color: var(--fg-muted);
}
.connections-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
${ENGAGEMENT_HEALTH_PANEL_STYLES}
`;
