/** D-182 §7.1 / D-196 — the {Access × Audience} install grant picker.
 *
 *  Installing a pack is the single explicit consent moment (spec §7.1). For a
 *  CONNECTION-BACKED pack — one carrying a by-value composition whose ops bind
 *  to a connection (`http` / `connection` / `mcp` / …, NOT `cli`) — the install
 *  dialog must let the owner choose, along two axes, what the install grants:
 *
 *    - **Access (what)** — `Read` → `+Write` → `All (destructive)`: a tier
 *      CEILING. `install_scope.access` maps it to the connection-profile
 *      operation groups granted at install (`read` → {read}; `write` → {read,
 *      write}; `all` → {read, write, admin, destructive}). Write/destructive
 *      grants still carry their per-action `ask` approval — a granted group is
 *      "granted-to-request", never a silent admit.
 *    - **Audience (who)** — independent checklist entries for the owner, D-196
 *      seller customers, and non-customer contracts, plus optional tiers and
 *      individual contracts. §7.2 (D-182): the safe default selects only the
 *      owner; the other entries fan the pack's grantable operations out to
 *      matching external doors / agents that EXIST at install time
 *      (`install-composition.ts` `applyInstallOpAdmissionFanOut`). OPTION A — a
 *      door added LATER starts with no access until you share again; the hints
 *      disclose this. The per-contract #contracts grid remains the way to share
 *      with one door.
 *
 *  ── Why this is the hole 5c left for the UI to close ──────────────────
 *  5c made the gateway DENY connection reads until a read group is granted
 *  (deny-until-granted, owner = strict). A local connection-backed pack now
 *  reaches the gate with NOTHING granted unless the install dialog sends
 *  `install_scope`. This picker is the surface that produces it — pre-selecting
 *  `Read` so the happy path stays one click (spec §7.1 "Default off,
 *  everywhere", recommend pre-selecting You / Read).
 *
 *  ── Three derivation entry points, one model ──────────────────────────
 *  The marketplace path (`packs.install`) holds the pack's by-value composition
 *  on the manifest, so it derives tiers from `composition.operations[].risk`
 *  filtered to non-`cli` ingredients (`installGrantModelFromManifest`). The
 *  kitchen authoring path (`ingredient.install`) has run the decompose preview,
 *  so it derives from the review's per-op `operation_families`
 *  (`risk_tier` + `surface`, where `surface === 'api'` is connection-backed and
 *  `'connector'` is cli) — `installGrantModelFromReviewFamilies`.
 *  The MCP enrollment path has the generated pack's reviewed operation rows;
 *  their conservative stored risk feeds `installGrantModelFromMcpReviewRows`.
 *  All three lower to the same `TieredOp[]` and model. (The handover's "read
 *  the decompose preview's `operation_groups`, NOT `default_grants`" footgun is moot here: we
 *  read per-op risk tiers, never `default_grants` — which still carries the OLD
 *  pre-5c union.)
 *
 *  ── cli packs are NOT this surface ────────────────────────────────────
 *  A pure-`cli` pack (whisper / ffmpeg / magick / docling / …) authorizes
 *  through the §7.2 per-contract reachability bit, surfaced by the POST-install
 *  `cli-grant-dialog.ts` — there is no connection profile and Scope is fixed to
 *  You only (§8 makes `cli` `external_exposable: false`). So a manifest with no
 *  connection-backed op yields a `null` model here and this picker never renders.
 *
 *  ── Render model: DOM nodes, not innerHTML ───────────────────────────
 *  Radios carry real listeners, so the picker builds via `createElement` (the
 *  same shape as `cli-grant-dialog.ts` / `pack-access-controls.ts`), not an HTML
 *  string. It is STATELESS — the host owns the selected access tier and re-runs
 *  `renderInstallGrantPicker` each render, reading the current selection and
 *  wiring `onAccess` back to its own state + re-render.
 *
 *  Spec: D-182 §7.1; the rpc carries `InstallGrantSelection`
 *  (`packages/contracts/src/bulk-pack.ts`); the install resolver that consumes
 *  it is `backend/server/src/ingredient-authoring/install-composition.ts`
 *  (`resolveInstallGrantWriteSet` / `ACCESS_TIER_PERMITS`). */

import {
  normalizeBulkPackInstallPlan,
  type BulkPackManifest,
  type CompositionReviewOperationFamily,
  type InstallAccessTier,
  type InstallAudienceSelection,
  type InstallScopeWho,
  type McpPackReviewRow,
  type OpKind,
  type RiskTier,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Model
// ════════════════════════════════════════════════════════════════

/** One connection-backed op reduced to what the picker needs: its id (for the
 *  transparency caption) and its risk tier. cli ops are filtered out BEFORE this
 *  — every op here lands on a connection profile group. */
interface TieredOp {
  id: string;
  risk: RiskTier;
}

/** The picker's derived render model. Recipe tools are read-tier grantable
 *  entries, so a recipe-only pack still has a model. `null` means the pack has
 *  neither recipe tools nor connection-backed operations (for example pure-cli). */
export interface InstallGrantPickerModel {
  /** Access tiers to offer, in ceiling order. Always starts with `read` (the
   *  safe default floor); `write` is added iff a write-tier op exists; `all` iff
   *  an admin- or destructive-tier op exists. */
  accessOptions: InstallAccessTier[];
  /** The pre-selected default access — always `read` (spec §7.1 happy path). */
  defaultAccess: InstallAccessTier;
  /** Per offered tier, the op ids it NEWLY grants relative to the tier below it
   *  (read → read ops; write → write ops; all → admin + destructive ops). Drives
   *  the transparency caption under each radio. Op ids are sorted for a stable
   *  byte-identical render across reinstalls. */
  grantsByAccess: Record<InstallAccessTier, string[]>;
}

/** The cli kind is the only `OpKind` that is NOT connection-backed (§7.2 routes
 *  it to the per-contract reachability bit + the post-install cli grant dialog).
 *  Everything else (`http` / `connection` / `mcp` / `service` / `dom` / `ai` /
 *  `chat` / `storage`) resolves through a connection profile, so its grants are
 *  what `install_scope` writes. */
const isConnectionBackedKind = (kind: OpKind): boolean => kind !== 'cli';

/** Build the model from grantable entries. Returns `null` only when there are
 *  none. */
const buildInstallGrantModel = (
  connOps: ReadonlyArray<TieredOp>,
): InstallGrantPickerModel | null => {
  if (connOps.length === 0) return null;

  const hasWrite = connOps.some((o) => o.risk === 'write');
  const hasAdminOrDestructive = connOps.some(
    (o) => o.risk === 'admin' || o.risk === 'destructive',
  );

  // `read` is always the offered floor + the pre-selected default (spec §7.1:
  // recommend pre-selecting Read so the happy path is one click; it is also the
  // safe minimum — a pack with only write ops still defaults to "grant nothing"
  // until the owner steps up to +Write).
  const accessOptions: InstallAccessTier[] = ['read'];
  if (hasWrite) accessOptions.push('write');
  if (hasAdminOrDestructive) accessOptions.push('all');

  const opsAtRisk = (...risks: RiskTier[]): string[] =>
    connOps
      .filter((o) => risks.includes(o.risk))
      .map((o) => o.id)
      .sort();

  return {
    accessOptions,
    defaultAccess: 'read',
    grantsByAccess: {
      read: opsAtRisk('read'),
      write: opsAtRisk('write'),
      all: opsAtRisk('admin', 'destructive'),
    },
  };
};

/** Marketplace path — derive the model from every normalized recipe ref and
 *  by-value composition. Walks `manifest.contents` for each composition, joins
 *  every op to its ingredient's `kind` (Table A), and keeps non-`cli` ops. */
export const installGrantModelFromManifest = (
  manifest: BulkPackManifest,
  /** D-247 D15.1 — per-recipe closure risk from `packs.install_preview`, keyed by
   *  `recipe_id`. Absent ⇒ recipes fall back to `read`, which is what shipped
   *  before and is only safe because the seed then lands them CLOSED. */
  recipeRisk?: ReadonlyMap<string, RiskTier>,
): InstallGrantPickerModel | null => {
  // ⛔⛔ D-247 D15.1 — A RECIPE'S TIER IS THE RISK OF WHAT IT CAN REACH, NOT
  // `read`. This line said `risk: 'read'` flat, whatever the recipe's ops do —
  // so a pack shipping a `chat_exposed` DESTRUCTIVE open adapter (7 of the 36 in
  // the shipped corpus) was granted at the picker's default Read, and the owner's
  // answer to "Read only" had enabled `refund-payment-square`.
  //
  // ⚠ THE HARM IS REACHABILITY, NOT AUTHORIZATION. No refund happens without an
  // approval (D4). But the owner said "read only" and got a refund tool in the
  // catalog, which is the exposure D-247 exists to control.
  //
  // The tier comes from the SERVER-resolved preview because the manifest does not
  // carry recipe bodies — see `packs.install_preview`. Absent ⇒ `read`, the prior
  // behaviour, because a guessed higher tier would silently hide recipes the
  // owner did nothing about.
  const connOps: TieredOp[] = normalizeBulkPackInstallPlan(manifest).recipes.map((recipe) => ({
    id: `${manifest.publisher}/${recipe.slug}`,
    risk: recipeRisk?.get(recipe.slug) ?? 'read',
  }));
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    const composition = content.composition;
    const kindBySlug = new Map<string, OpKind>();
    for (const ingredient of composition.ingredients) {
      kindBySlug.set(ingredient.slug, ingredient.kind);
    }
    for (const op of composition.operations) {
      const kind = kindBySlug.get(op.ingredient);
      // An op whose join key resolves to no ingredient row is a malformed
      // composition the decompose validator would reject at install — treat it
      // defensively as connection-backed (fail toward SHOWING the consent
      // surface rather than silently skipping it).
      if (kind === undefined || isConnectionBackedKind(kind)) {
        connOps.push({ id: op.op, risk: op.risk });
      }
    }
  }
  return buildInstallGrantModel(connOps);
};

/** Kitchen authoring path — derive the model from the decompose preview's
 *  review projection. Each `operation_families` entry carries the op's
 *  `risk_tier` + a coarse `surface` (`'api'` for connection-backed kinds,
 *  `'connector'` for cli — see `@recued/ingredient-authoring` `surfaceForKind`).
 *  Keeps the `api` families. */
export const installGrantModelFromReviewFamilies = (
  families: ReadonlyArray<CompositionReviewOperationFamily>,
): InstallGrantPickerModel | null => {
  const connOps: TieredOp[] = families
    .filter((f) => f.surface === 'api')
    .map((f) => ({ id: f.key, risk: f.risk_tier }));
  return buildInstallGrantModel(connOps);
};

/** MCP enrollment path — derive from the exact rows the owner reviewed. The
 *  generated composition stores every tool at the conservative `write` /
 *  `ask` floor, so the default Read selection grants none and stepping up to
 *  Read + write explicitly grants precisely these TOCTOU-bound op ids. */
export const installGrantModelFromMcpReviewRows = (
  rows: ReadonlyArray<McpPackReviewRow>,
): InstallGrantPickerModel | null => buildInstallGrantModel(
  rows.map((row) => ({ id: row.op, risk: row.stored.risk })),
);

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + host introspection
// ════════════════════════════════════════════════════════════════

export const INSTALL_GRANT_PICKER_ATTR = 'data-recued-install-grant-picker';
/** One access-tier radio. Carries `data-access` = the `InstallAccessTier`. */
export const INSTALL_GRANT_ACCESS_OPTION_ATTR = 'data-recued-install-grant-access';
/** The scope section wrapper (§7.2 / D-196 — audience picker). */
export const INSTALL_GRANT_SCOPE_ATTR = 'data-recued-install-grant-scope';
/** One broad audience checkbox. Carries legacy `data-scope` vocabulary. */
export const INSTALL_GRANT_SCOPE_OPTION_ATTR = 'data-recued-install-grant-scope-option';
/** Expanded per-tier / per-contract checklist option. */
export const INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR =
  'data-recued-install-grant-audience-detail-option';

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const ACCESS_LABEL: Record<InstallAccessTier, string> = {
  read: 'Read only',
  write: 'Read + write',
  all: 'Full access',
};

const ACCESS_HINT: Record<InstallAccessTier, string> = {
  read: 'View data. Safe and idempotent — the recommended default.',
  write: 'Also create and update. Each write still asks for approval before it runs.',
  all: 'Also delete and admin operations. Each still asks for approval before it runs.',
};

const SCOPE_LABEL: Record<InstallScopeWho, string> = {
  owner: 'You',
  all_customers: 'All customers',
  all_other_contracts: 'All other contracts',
  all_contracts: 'Everyone',
};

export interface InstallAudienceOption {
  readonly id: string;
  readonly label: string;
}

export const DEFAULT_INSTALL_AUDIENCE: InstallAudienceSelection = Object.freeze({
  owner: true,
  all_customers: false,
  all_other_contracts: false,
});

/** Compatibility adapter for test seams and pre-checklist host state. Legacy
 *  non-owner radio choices always included the owner in practice because the
 *  connection-level pack grant made owner access reachable. */
export const installAudienceFromLegacyScope = (
  scope: InstallScopeWho,
): InstallAudienceSelection => {
  switch (scope) {
    case 'owner':
      return { owner: true, all_customers: false, all_other_contracts: false };
    case 'all_customers':
      return { owner: true, all_customers: true, all_other_contracts: false };
    case 'all_other_contracts':
      return { owner: true, all_customers: false, all_other_contracts: true };
    case 'all_contracts':
      return { owner: true, all_customers: true, all_other_contracts: true };
  }
};

/** Copy + normalize audience state so mutable host maps never share arrays. */
export const resolveInstallAudienceSelection = (
  picked: InstallAudienceSelection | undefined,
): InstallAudienceSelection => ({
  owner: picked?.owner ?? DEFAULT_INSTALL_AUDIENCE.owner,
  all_customers: picked?.all_customers ?? DEFAULT_INSTALL_AUDIENCE.all_customers,
  all_other_contracts:
    picked?.all_other_contracts ?? DEFAULT_INSTALL_AUDIENCE.all_other_contracts,
  ...(picked?.customer_tier_ids !== undefined
    ? { customer_tier_ids: [...new Set(picked.customer_tier_ids)] }
    : {}),
  ...(picked?.contract_ids !== undefined
    ? { contract_ids: [...new Set(picked.contract_ids)] }
    : {}),
});

const SCOPE_HINT: Record<InstallScopeWho, string> = {
  owner: 'Your own AI, in your chat, may use these grants. Recommended.',
  all_customers:
    'Seller customer doors that already exist may use these grants. Customers added later start with no access until you share again.',
  all_other_contracts:
    'Non-customer contracts that already exist may use these grants. Contracts added later start with no access until you share again.',
  all_contracts:
    'Every agent and external door you have now may use them too. Doors you add later start with no access until you share again.',
};

/** ⛔ Access and Scope are ONE decision in two steps — "grant THESE operations to
 *  THOSE contracts" — and the old copy described each half as if it stood alone
 *  ("Choose what this pack may do" / "Who may use these grants"). Read that way,
 *  the tier looks like a global capability switch, and the pairing that actually
 *  governs the install is invisible.
 *
 *  ⚠ The consequence is not abstract. "You" is itself a CONTRACT, so the tier
 *  chosen here governs the owner's own use of the pack: install a Records pack at
 *  the default `read` and its own write recipes are denied when YOU run them. A
 *  reader who thinks Scope is only about sharing has no way to predict that. */
const COPY = {
  access_heading: 'Access — step 1 of 2',
  access_intro:
    'Choose the operations to grant. Whatever you pick here is granted to the '
    + 'contracts you choose in step 2 below — including you. Each tier includes '
    + 'the ones above it. Nothing is granted until you install; you can change '
    + 'both later in the pack’s Access tab.',
  // "Grants:" read as the complete set for the tier. It is the ops the tier ADDS
  // — the server grants the cumulative band (write ⇒ read + write) — so a tier
  // listing one write op while also granting every read op looked exhaustive.
  grants_prefix: 'Adds: ',
  scope_heading: 'Scope — step 2 of 2',
  scope_intro:
    'Who receives the access chosen in step 1. “You” is a contract like any '
    + 'other: unchecking it revokes your own use of these operations. You can '
    + 'change this later in the pack’s Access tab.',
} as const;

// ════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════

export interface RenderInstallGrantPickerOptions {
  /** DOM document seam (the host's `doc`). */
  document: Document;
  /** The derived model (non-null — callers gate the call on `!== null`). */
  model: InstallGrantPickerModel;
  /** Currently selected access tier (host-owned state). */
  access: InstallAccessTier;
  /** Independent D-196 audience checklist (host-owned; owner-only default). */
  audience?: InstallAudienceSelection;
  /** Legacy renderer input retained for narrowed/test hosts. */
  scope?: InstallScopeWho;
  /** Expanded customer-tier choices, when the host can resolve Seller state. */
  customerTierOptions?: readonly InstallAudienceOption[];
  /** Expanded individual contract choices, when the host can list contracts. */
  contractOptions?: readonly InstallAudienceOption[];
  /** Disable the radios while an install rpc is in flight. */
  disabled?: boolean;
  /** Fired when the owner picks a different access tier. The host updates its
   *  state + re-renders. */
  onAccess: (tier: InstallAccessTier) => void;
  /** Fired with the complete checklist after any broad or expanded toggle. */
  onAudience?: (audience: InstallAudienceSelection) => void;
  /** Legacy callback retained for narrowed/test hosts. */
  onScope?: (scope: InstallScopeWho) => void;
}

/** Broad checklist options in offered order. */
type ChecklistAudienceWho = Exclude<InstallScopeWho, 'all_contracts'>;
const SCOPE_OPTIONS: readonly ChecklistAudienceWho[] = [
  'owner',
  'all_customers',
  'all_other_contracts',
];

/** Build the picker section. Stateless — re-call each render. */
export const renderInstallGrantPicker = (
  opts: RenderInstallGrantPickerOptions,
): HTMLElement => {
  const doc = opts.document;
  const { model, access, onAccess, onAudience } = opts;
  const audience = resolveInstallAudienceSelection(
    opts.audience ?? (opts.scope ? installAudienceFromLegacyScope(opts.scope) : undefined),
  );
  const disabled = opts.disabled === true;

  const section = doc.createElement('section');
  section.setAttribute(INSTALL_GRANT_PICKER_ATTR, '');
  section.className = 'install-grant-picker';
  section.setAttribute('role', 'group');

  // ── Access axis ──────────────────────────────────────────────────
  const accessHeading = doc.createElement('p');
  accessHeading.className = 'igp-heading';
  accessHeading.textContent = COPY.access_heading;
  section.appendChild(accessHeading);

  const intro = doc.createElement('p');
  intro.className = 'igp-intro';
  intro.textContent = COPY.access_intro;
  section.appendChild(intro);

  const list = doc.createElement('ul');
  list.className = 'igp-access-list';
  for (const tier of model.accessOptions) {
    const item = doc.createElement('li');
    item.className = 'igp-access-row';
    const label = doc.createElement('label');
    label.className = 'igp-access-label';

    const radio = doc.createElement('input');
    radio.setAttribute('type', 'radio');
    radio.setAttribute(INSTALL_GRANT_ACCESS_OPTION_ATTR, '');
    radio.setAttribute('data-access', tier);
    radio.className = 'igp-access-radio';
    radio.checked = tier === access;
    if (disabled) radio.setAttribute('disabled', '');
    else
      radio.addEventListener('change', () => {
        // A radio only emits `change` when it BECOMES checked, so a stale
        // re-fire can't deselect the live choice.
        onAccess(tier);
      });
    label.appendChild(radio);

    const labelText = doc.createElement('span');
    labelText.className = 'igp-access-name';
    labelText.textContent = ACCESS_LABEL[tier];
    label.appendChild(labelText);

    const hint = doc.createElement('span');
    hint.className = 'igp-access-hint';
    hint.textContent = ACCESS_HINT[tier];
    label.appendChild(hint);

    item.appendChild(label);

    // Transparency caption — the ops THIS tier newly grants. Omitted when the
    // tier grants no op (e.g. a `read` floor on a write-only pack).
    const grantedOps = model.grantsByAccess[tier];
    if (grantedOps.length > 0) {
      const ops = doc.createElement('span');
      ops.className = 'igp-access-ops';
      ops.textContent = `${COPY.grants_prefix}${grantedOps.join(', ')}`;
      item.appendChild(ops);
    }

    list.appendChild(item);
  }
  section.appendChild(list);

  // ── Scope axis (§7.2 / D-196 — audience) ─────────────────────────
  const scopeSection = doc.createElement('div');
  scopeSection.setAttribute(INSTALL_GRANT_SCOPE_ATTR, '');
  scopeSection.className = 'igp-scope';

  const scopeHeading = doc.createElement('p');
  scopeHeading.className = 'igp-heading';
  scopeHeading.textContent = COPY.scope_heading;
  scopeSection.appendChild(scopeHeading);

  const scopeIntro = doc.createElement('p');
  scopeIntro.className = 'igp-intro';
  scopeIntro.textContent = COPY.scope_intro;
  scopeSection.appendChild(scopeIntro);

  const scopeList = doc.createElement('ul');
  scopeList.className = 'igp-scope-list';
  for (const who of SCOPE_OPTIONS) {
    const item = doc.createElement('li');
    item.className = 'igp-scope-row';
    const label = doc.createElement('label');
    label.className = 'igp-scope-label';

    const checkbox = doc.createElement('input');
    checkbox.setAttribute('type', 'checkbox');
    checkbox.setAttribute(INSTALL_GRANT_SCOPE_OPTION_ATTR, '');
    checkbox.setAttribute('data-scope', who);
    checkbox.className = 'igp-scope-check';
    checkbox.checked = audience[who] === true;
    if (disabled) checkbox.setAttribute('disabled', '');
    else
      checkbox.addEventListener('change', () => {
        if (onAudience) onAudience({ ...audience, [who]: checkbox.checked });
        else opts.onScope?.(who);
      });
    label.appendChild(checkbox);

    const labelText = doc.createElement('span');
    labelText.className = 'igp-scope-name';
    labelText.textContent = SCOPE_LABEL[who];
    label.appendChild(labelText);

    const hint = doc.createElement('span');
    hint.className = 'igp-scope-hint';
    hint.textContent = SCOPE_HINT[who];
    label.appendChild(hint);

    item.appendChild(label);

    const expandedOptions = who === 'all_customers'
      ? opts.customerTierOptions
      : who === 'all_other_contracts'
        ? opts.contractOptions
        : undefined;
    if (expandedOptions !== undefined && expandedOptions.length > 0) {
      const details = doc.createElement('details');
      details.className = 'igp-audience-details';
      const summary = doc.createElement('summary');
      summary.textContent = who === 'all_customers'
        ? 'Choose customer tiers'
        : 'Choose individual contracts';
      details.appendChild(summary);
      const selectedIds = new Set(
        who === 'all_customers'
          ? audience.customer_tier_ids ?? []
          : audience.contract_ids ?? [],
      );
      for (const option of expandedOptions) {
        const detailLabel = doc.createElement('label');
        detailLabel.className = 'igp-audience-detail-label';
        const detailCheck = doc.createElement('input');
        detailCheck.setAttribute('type', 'checkbox');
        detailCheck.setAttribute(INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR, '');
        detailCheck.setAttribute('data-audience-kind', who === 'all_customers' ? 'tier' : 'contract');
        detailCheck.setAttribute('data-audience-id', option.id);
        detailCheck.checked = selectedIds.has(option.id);
        if (disabled) detailCheck.setAttribute('disabled', '');
        else detailCheck.addEventListener('change', () => {
          const next = new Set(selectedIds);
          if (detailCheck.checked) next.add(option.id);
          else next.delete(option.id);
          onAudience?.({
            ...audience,
            ...(who === 'all_customers'
              ? { customer_tier_ids: [...next] }
              : { contract_ids: [...next] }),
          });
        });
        detailLabel.appendChild(detailCheck);
        const detailText = doc.createElement('span');
        detailText.textContent = option.label;
        detailLabel.appendChild(detailText);
        details.appendChild(detailLabel);
      }
      item.appendChild(details);
    }
    scopeList.appendChild(item);
  }
  scopeSection.appendChild(scopeList);

  section.appendChild(scopeSection);

  return section;
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the install grant picker, scoped under
 *  `[data-recued-install-grant-picker]`. The settings route joins this into its
 *  one `<style>` bundle (mirrors `CLI_GRANT_DIALOG_STYLES`); the kitchen route
 *  joins it likewise. Inert until the picker renders inside an install dialog. */
export const INSTALL_GRANT_PICKER_STYLES = `
[data-recued-install-grant-picker] {
  margin: 16px 0 4px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
[data-recued-install-grant-picker] .igp-heading {
  font-size: 13px;
  font-weight: 700;
  margin: 0 0 5px;
}
[data-recued-install-grant-picker] .igp-intro {
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg-muted);
  margin: 0 0 12px;
}
[data-recued-install-grant-picker] .igp-access-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(176px, 1fr));
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
[data-recued-install-grant-picker] .igp-access-row {
  display: grid;
  align-content: start;
  gap: 7px;
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
[data-recued-install-grant-picker] .igp-access-row:hover {
  border-color: var(--border-strong);
}
[data-recued-install-grant-picker] .igp-access-row:has(.igp-access-radio:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 0 0 0 1px var(--accent);
}
[data-recued-install-grant-picker] .igp-access-label {
  display: grid;
  grid-template-columns: 19px minmax(0, 1fr);
  gap: 3px 8px;
  align-items: start;
  cursor: pointer;
}
[data-recued-install-grant-picker] :is(.igp-access-radio, .igp-scope-check, .igp-audience-detail-label input) {
  width: 17px;
  height: 17px;
  margin: 1px 0 0;
  accent-color: var(--accent);
}
[data-recued-install-grant-picker] .igp-access-radio[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-install-grant-picker] .igp-access-name {
  font-size: 13px;
  font-weight: 650;
}
[data-recued-install-grant-picker] .igp-access-hint {
  grid-column: 2;
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg-muted);
}
[data-recued-install-grant-picker] .igp-access-ops {
  display: block;
  font-size: 11px;
  line-height: 1.4;
  color: var(--fg-muted);
  font-family: var(--mono, ui-monospace, monospace);
  margin: 0 0 0 27px;
  word-break: break-word;
}
[data-recued-install-grant-picker] .igp-scope {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
[data-recued-install-grant-picker] .igp-scope-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
[data-recued-install-grant-picker] .igp-scope-row {
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
[data-recued-install-grant-picker] .igp-scope-row:hover {
  border-color: var(--border-strong);
}
[data-recued-install-grant-picker] .igp-scope-row:has(.igp-scope-check:checked) {
  border-color: var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 0 0 0 1px var(--accent);
}
[data-recued-install-grant-picker] .igp-scope-label {
  display: grid;
  grid-template-columns: 19px minmax(0, 1fr);
  gap: 3px 8px;
  align-items: start;
  cursor: pointer;
}
[data-recued-install-grant-picker] .igp-audience-details {
  grid-column: 1 / -1;
  margin: 7px 0 0 25px;
  font-size: 11px;
  color: var(--fg-muted);
}
[data-recued-install-grant-picker] .igp-audience-details summary {
  cursor: pointer;
}
[data-recued-install-grant-picker] .igp-audience-detail-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
  cursor: pointer;
}
[data-recued-install-grant-picker] .igp-scope-check[disabled] {
  opacity: 0.6;
  cursor: default;
}
[data-recued-install-grant-picker] .igp-scope-name {
  font-size: 13px;
  font-weight: 650;
}
[data-recued-install-grant-picker] .igp-scope-hint {
  grid-column: 2;
  font-size: 11px;
  line-height: 1.45;
  color: var(--fg-muted);
}
[data-recued-install-grant-picker] :is(.igp-access-radio, .igp-scope-check):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  [data-recued-install-grant-picker] { padding: 13px; }
  [data-recued-install-grant-picker] .igp-access-list,
  [data-recued-install-grant-picker] .igp-scope-list {
    grid-template-columns: 1fr;
  }
}
`;
