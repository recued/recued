/** Pre-install permission preview — what a pack WOULD be allowed to do.
 *
 *  ⛔⛔ AN EMPTY PERMISSIONS TAB IS NOT A NEUTRAL BLANK. Before this, opening a
 *  not-yet-installed pack's Permissions tab rendered "no operation defaults to
 *  customize", because the D-211 owner-override matrix only exists for an INSTALLED
 *  pack's operations. To a reader that says "this pack needs no permissions" — which is
 *  false for a pack about to request `Files.ReadWrite` and eleven write operations, and
 *  it is the DANGEROUS direction for an absence to be misread. Install is also the one
 *  moment the decision is still free; afterwards the question is only whether to
 *  uninstall.
 *
 *  🔑 THIS IS A RENDERING GAP, NOT A DATA GAP. Opening a marketplace pack's detail
 *  already resolves its manifest (`ensureDetailResolved` → the server-side
 *  `packs.resolveBySlug`, so it stays marketplace-authoritative and is never fetched or
 *  trusted client-side). Everything below is derived from that same manifest the install
 *  dialog's Access step already reads — no new fetch, no new trust boundary.
 *
 *  ⚠ IT IS DELIBERATELY READ-ONLY AND SAYS SO. Nothing here grants anything; it is a
 *  disclosure of what installing would permit. The framing line matters as much as the
 *  list: without it a reader can mistake a preview for CURRENT state, which is the same
 *  class of "display is not enforcement" defect that made the connection operation-grant
 *  panel misleading enough to retire (D-233).
 */
import {
  RISK_APPROVAL_FLOOR,
  requiredScopesByConnection,
  type BulkPackManifest,
  type OperationRiskTier,
} from '@recued/contracts';

export const PACK_PERMISSION_PREVIEW_ATTR = 'data-recued-pack-permission-preview';
/** One risk-tier row. Carries `data-tier` = the {@link OperationRiskTier}. */
export const PACK_PERMISSION_PREVIEW_TIER_ATTR = 'data-recued-pack-permission-tier';
/** One connection row. Carries `data-connection` = the connection slot. */
export const PACK_PERMISSION_PREVIEW_CONNECTION_ATTR =
  'data-recued-pack-permission-connection';

/** Ordered worst-last so the reader meets the benign tiers first and the escalation
 *  reads as an escalation. A tier with no operations is omitted entirely rather than
 *  shown as zero — "destructive: 0" invites reading a zero where there is simply
 *  nothing. */
const TIER_ORDER: ReadonlyArray<OperationRiskTier> = [
  'read',
  'write',
  'admin',
  'destructive',
];

const TIER_LABEL: Record<OperationRiskTier, string> = {
  read: 'Read',
  write: 'Write',
  admin: 'Administrative',
  destructive: 'Destructive',
};

/** What the owner will actually experience per tier. Derived from
 *  `RISK_APPROVAL_FLOOR` rather than restated, so the promise made here cannot drift
 *  from the floor the gateway enforces — the two would otherwise be edited apart, and a
 *  disclosure that overstates protection is worse than none. */
const approvalPhrase = (tier: OperationRiskTier): string => {
  switch (RISK_APPROVAL_FLOOR[tier]) {
    case 'never':
      return 'runs without asking you';
    case 'ask':
      return 'asks you before it does anything';
    case 'always':
      return 'asks you every single time';
    default:
      return 'asks you before it does anything';
  }
};

export interface PackPermissionPreviewModel {
  /** Operation counts by tier, worst-last, omitting tiers with none. */
  tiers: ReadonlyArray<{ tier: OperationRiskTier; count: number }>;
  /** Connection slots the pack binds, with the scopes it will request. */
  connections: ReadonlyArray<{ connection: string; scopes: ReadonlyArray<string> }>;
  /** Total connection-backed operations — the headline number. */
  operationCount: number;
}

/** Derive the preview from a resolved manifest. Pure, so the shape is testable without
 *  a DOM and the renderer below stays a projection of it.
 *
 *  ⚠ COUNTS EVERY DECLARED OPERATION, including `cli`-backed ones. The install grant
 *  picker deliberately filters to connection-backed kinds because only those are
 *  grantable on a connection — but this surface answers a different question ("what can
 *  this pack do?"), and a local CLI operation is still something the pack does. Filtering
 *  here would under-report a pack whose whole purpose is local execution. */
export const packPermissionPreviewModel = (
  manifest: BulkPackManifest,
): PackPermissionPreviewModel | null => {
  const byTier = new Map<OperationRiskTier, number>();
  let operationCount = 0;
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    for (const op of content.composition.operations) {
      operationCount += 1;
      byTier.set(op.risk, (byTier.get(op.risk) ?? 0) + 1);
    }
  }
  /** ⛔⛔ SLOTS COME FROM THE INGREDIENTS, SCOPES ARE ATTACHED AFTERWARDS. The obvious
   *  implementation — enumerate `requiredScopesByConnection(manifest)` — silently DROPS
   *  a connection whose operations declare no `required_scopes`, because that map is
   *  keyed by the scopes it found. The pack still binds the account and still calls it;
   *  the owner would simply never be told. Found by driving the real panel against a
   *  fixture whose operation declares no scopes, not by reading this function. */
  const scopesBySlot = requiredScopesByConnection(manifest);
  const slots = new Set<string>(Object.keys(scopesBySlot));
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    for (const ingredient of content.composition.ingredients) {
      const slot = (ingredient as { http?: { connection?: string } }).http?.connection;
      if (typeof slot === 'string' && slot !== '') slots.add(slot);
    }
  }
  const connections = [...slots]
    .map((connection) => ({
      connection,
      scopes: [...(scopesBySlot[connection] ?? [])].sort(),
    }))
    .sort((a, b) => a.connection.localeCompare(b.connection));

  /** Nothing to disclose ⇒ no section, rather than an empty one. A pack that truly
   *  declares no operations and binds no connection is the one case where silence is
   *  honest. */
  if (operationCount === 0 && connections.length === 0) return null;

  return {
    tiers: TIER_ORDER
      .filter((tier) => (byTier.get(tier) ?? 0) > 0)
      .map((tier) => ({ tier, count: byTier.get(tier) ?? 0 })),
    connections,
    operationCount,
  };
};

export interface PackPermissionPreviewOptions {
  document: Document;
  manifest: BulkPackManifest;
}

/** Render the read-only preview, or `null` when there is nothing to disclose. */
export const renderPackPermissionPreview = (
  opts: PackPermissionPreviewOptions,
): HTMLElement | null => {
  const model = packPermissionPreviewModel(opts.manifest);
  if (model === null) return null;
  const doc = opts.document;

  const root = doc.createElement('div');
  root.setAttribute(PACK_PERMISSION_PREVIEW_ATTR, '');
  root.className = 'pack-permission-preview';

  /** ⛔ THE FRAMING LINE IS LOAD-BEARING, not decoration. Without it this list is
   *  indistinguishable from a grant matrix showing current state. */
  const note = doc.createElement('p');
  note.className = 'pack-permission-preview-note';
  note.textContent =
    'Not installed, so nothing is allowed yet. This is what installing it would let it do, '
    + 'and you choose how much it may do while you install it.';
  root.appendChild(note);

  if (model.tiers.length > 0) {
    const heading = doc.createElement('h4');
    heading.className = 'pack-permission-preview-heading';
    heading.textContent = `What it can do (${model.operationCount} operations)`;
    root.appendChild(heading);

    const list = doc.createElement('ul');
    list.className = 'pack-permission-preview-list';
    for (const row of model.tiers) {
      const item = doc.createElement('li');
      item.setAttribute(PACK_PERMISSION_PREVIEW_TIER_ATTR, '');
      item.setAttribute('data-tier', row.tier);
      item.className = 'pack-permission-preview-row';
      item.textContent =
        `${TIER_LABEL[row.tier]} — ${row.count} `
        + `${row.count === 1 ? 'operation' : 'operations'}, ${approvalPhrase(row.tier)}`;
      list.appendChild(item);
    }
    root.appendChild(list);
  }

  if (model.connections.length > 0) {
    const heading = doc.createElement('h4');
    heading.className = 'pack-permission-preview-heading';
    heading.textContent = 'Accounts it uses';
    root.appendChild(heading);

    const list = doc.createElement('ul');
    list.className = 'pack-permission-preview-list';
    for (const row of model.connections) {
      const item = doc.createElement('li');
      item.setAttribute(PACK_PERMISSION_PREVIEW_CONNECTION_ATTR, '');
      item.setAttribute('data-connection', row.connection);
      item.className = 'pack-permission-preview-row';
      /** ⚠ The scopes are named in full rather than summarised. They are the exact
       *  strings the provider's own consent screen will show, so an owner comparing the
       *  two should find them identical — a paraphrase here would make a legitimate
       *  screen look wrong. */
      item.textContent =
        row.scopes.length > 0
          ? `${row.connection} — requests ${row.scopes.join(', ')}`
          : `${row.connection} — no scopes declared`;
      list.appendChild(item);
    }
    root.appendChild(list);
  }

  return root;
};
