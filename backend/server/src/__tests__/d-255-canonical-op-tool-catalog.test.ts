/** D-255 — the canonical op tool descriptors a door may be granted.
 *
 *  ⛔ The assertions that matter are the ABSENCES: an alias with no bound
 *  connection must not be listed, and the connection must never reach the wire
 *  NAME. Both are shapes that look harmless and are not — the first spends a
 *  model's turn earning an unpredictable refusal, and the second rebuilds the
 *  per-vendor catalog this surface exists to collapse.
 */

import { describe, expect, it } from 'vitest';
import { CANONICAL_OP_TOOL_PREFIX } from '@recued/contracts';

import { buildCanonicalOpToolDescriptors } from '../canonical-op-tool-catalog.js';
import type { ConnectionVendorEntity } from '@recued/contracts';

/** A synthetic accounting vendor. ⛔ REQUIRED FOR A NON-VACUOUS TEST: the shipped
 *  registry declares ZERO `acct_alias` entries (12 `crm_alias`, 0 `acct_alias`), so
 *  asserting "invoice is not offered" against it passes for the wrong reason —
 *  `invoice` cannot be offered to anyone, bound connection or not. Injecting a
 *  vendor that DOES declare one is what makes the absence attributable to the thing
 *  under test. Caught by a mutation that reded only one of two absence tests. */
const ACCT_REGISTRY: ReadonlyArray<ConnectionVendorEntity> = [
  { vendor: 'hubspot', entity: 'contact', crm_alias: 'contact' },
  { vendor: 'ledgerco', entity: 'invoice', acct_alias: 'invoice' },
] as unknown as ReadonlyArray<ConnectionVendorEntity>;

const build = (bound: ReadonlyArray<{ name: string; vendor: string }>) =>
  buildCanonicalOpToolDescriptors({ boundConnections: bound });

describe('buildCanonicalOpToolDescriptors — what is offered', () => {
  it('offers the CRUD verbs for an alias a bound vendor declares', () => {
    // ⚠ `search` is deliberately ABSENT for these three — a Tier-1 tool already
    // fans out over MORE sources for the same entity (see the suppression block
    // below). This test asserted five verbs before that was noticed.
    const names = build([{ name: 'acme-corp', vendor: 'hubspot' }]).map((d) => d.opId);
    for (const verb of ['read', 'create', 'update', 'delete']) {
      expect(names).toContain(`contact.${verb}`);
      expect(names).toContain(`deal.${verb}`);
      expect(names).toContain(`account.${verb}`);
    }
  });

  it('wire-names them under the canonical prefix, distinct from a raw op', () => {
    const d = build([{ name: 'acme-corp', vendor: 'hubspot' }])
      .find((x) => x.opId === 'contact.update');
    expect(d?.wireName).toBe(`${CANONICAL_OP_TOOL_PREFIX}contact.update`);
    expect(d?.wireName.startsWith('recued_op_')).toBe(false);
  });

  it('classifies from the verb, not from a default', () => {
    const byOp = new Map(build([{ name: 'c', vendor: 'hubspot' }]).map((d) => [d.opId, d]));
    expect(byOp.get('contact.read')?.classification).toBe('read');
    expect(byOp.get('contact.create')?.classification).toBe('write');
    expect(byOp.get('contact.update')?.classification).toBe('write');
    // `delete` is `destructive` at the kernel; the grant classification collapses
    // every non-read tier to `write`, which is the checklist's vocabulary.
    expect(byOp.get('contact.delete')?.classification).toBe('write');
  });
});

describe('buildCanonicalOpToolDescriptors — what is NOT offered', () => {
  it('⛔ offers nothing when no connection is bound', () => {
    expect(build([])).toEqual([]);
  });

  it('⛔ omits an alias no bound vendor declares — proven against a registry that HAS it', () => {
    // A CRM-only owner has no accounting connection, so `invoice.*` would be a tool
    // that can only fail — D-254's visibility matrix, verbatim. Asserted against
    // ACCT_REGISTRY so the absence is caused by the unbound connection and not by
    // the alias being unregistered.
    const crmOnly = buildCanonicalOpToolDescriptors({
      boundConnections: [{ name: 'acme-corp', vendor: 'hubspot' }],
      registry: ACCT_REGISTRY,
    });
    const aliases = new Set(crmOnly.map((d) => d.alias));
    expect(aliases.has('contact')).toBe(true);
    expect(aliases.has('invoice')).toBe(false);
  });

  it('offers the accounting family once its vendor IS bound — same builder', () => {
    // `KernelConnectionFamily` is generic over conventions, so acct rides the crm
    // path with no branch. ⚠ Inert on the shipped registry (0 acct_alias entries);
    // this is the only thing exercising it.
    const withAcct = buildCanonicalOpToolDescriptors({
      boundConnections: [{ name: 'books1', vendor: 'ledgerco' }],
      registry: ACCT_REGISTRY,
    });
    expect(withAcct.map((d) => d.opId)).toContain('invoice.update');
    expect(withAcct.find((d) => d.opId === 'invoice.update')?.connections).toEqual(['books1']);
  });

  it('⛔ omits an unregistered vendor entirely', () => {
    expect(build([{ name: 'x', vendor: 'notavendor' }])).toEqual([]);
  });
});

describe('buildCanonicalOpToolDescriptors — the connection is an ARG, never the name', () => {
  it('⛔ mints ONE descriptor per (alias, verb) across many connections', () => {
    const many = build([
      { name: 'hubspot1', vendor: 'hubspot' },
      { name: 'hubspot2', vendor: 'hubspot' },
      { name: 'sf1', vendor: 'salesforce' },
    ]);
    const updates = many.filter((d) => d.opId === 'contact.update');
    expect(updates).toHaveLength(1);
    // Per-connection names would rebuild the per-vendor catalog and put the
    // connection into a NAME, which D-254 ruled carries no authority.
    for (const d of many) expect(d.wireName).not.toMatch(/hubspot1|hubspot2|sf1/);
  });

  it('carries every serving connection as an arg enum, in enrolment order', () => {
    const d = build([
      { name: 'hubspot1', vendor: 'hubspot' },
      { name: 'hubspot2', vendor: 'hubspot' },
      { name: 'sf1', vendor: 'salesforce' },
    ]).find((x) => x.opId === 'contact.update');
    expect(d?.connections).toEqual(['hubspot1', 'hubspot2', 'sf1']);
    const schema = d?.inputSchema as {
      properties: { connection: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.connection.enum).toEqual(['hubspot1', 'hubspot2', 'sf1']);
    expect(schema.required).toEqual(['connection']);
  });

  it('cross-vendor aliases merge; a vendor-specific one does not leak', () => {
    // HubSpot `company` and Salesforce `account` both carry crm_alias `account`,
    // so one canonical `account.*` serves both — that IS the collapse.
    const d = build([
      { name: 'hubspot1', vendor: 'hubspot' },
      { name: 'sf1', vendor: 'salesforce' },
    ]).find((x) => x.opId === 'account.read');
    expect(d?.connections).toEqual(['hubspot1', 'sf1']);
  });
});

describe('buildCanonicalOpToolDescriptors — the profile gate is contract-general', () => {
  const bound = [
    { name: 'acme-corp', vendor: 'hubspot' },
    { name: 'sf1', vendor: 'salesforce' },
  ];
  const withGrants = (granted: Record<string, readonly string[]>) =>
    buildCanonicalOpToolDescriptors({
      boundConnections: bound,
      grantsVendorOp: (conn, opKey) => (granted[conn] ?? []).includes(opKey),
    });

  it('⛔ offers only the verbs the connection profile grants', () => {
    // A read grant without a write grant is the COMMON case (deny-until-granted,
    // D-182 §7.1), so the filter has to be per verb, not per alias.
    const ops = withGrants({ 'acme-corp': ['contact.read'] }).map((d) => d.opId);
    expect(ops).toContain('contact.read');
    expect(ops).not.toContain('contact.update');
    expect(ops).not.toContain('deal.read');
  });

  it('⛔ maps the alias to the VENDOR entity before checking the grant', () => {
    // Canonical `account` is `company` on HubSpot and `account` on Salesforce.
    // Checking the alias name directly would silently never match HubSpot.
    const hubspotOnly = buildCanonicalOpToolDescriptors({
      boundConnections: [{ name: 'acme-corp', vendor: 'hubspot' }],
      grantsVendorOp: (_c, opKey) => opKey === 'company.update',
    });
    expect(hubspotOnly.map((d) => d.opId)).toEqual(['account.update']);
  });

  it('lists only the connections that grant it, and drops the tool at zero', () => {
    const ds = withGrants({ 'acme-corp': ['contact.update'], sf1: [] });
    const update = ds.find((d) => d.opId === 'contact.update');
    expect(update?.connections).toEqual(['acme-corp']);
    expect(ds.find((d) => d.opId === 'contact.read')).toBeUndefined();
  });

  it('⛔ a connection with NO grants is excluded — deny until granted', () => {
    expect(withGrants({})).toEqual([]);
  });

  it('⚠ absent gate ⇒ unfiltered, the documented dbless posture', () => {
    const unfiltered = buildCanonicalOpToolDescriptors({ boundConnections: bound });
    expect(unfiltered.length).toBeGreaterThan(0);
  });
});

describe('⛔ canonical search is SUPPRESSED where Tier-1 fans out wider', () => {
  const bound = [{ name: 'acme-corp', vendor: 'hubspot' }];

  it('offers no canonical search for an alias a Tier-1 tool already covers', () => {
    // `contact.search` (Tier-1) fans out over the OWNER'S OWN data.contact graph
    // AND every CRM mirror. A canonical `contact.search` reaches connections only,
    // so shipping both hands the model two tools for one concept where the newer
    // one silently omits a source.
    const ops = build(bound).map((d) => d.opId);
    for (const alias of ['contact', 'deal', 'account']) {
      expect(ops, `${alias}.search must be suppressed`).not.toContain(`${alias}.search`);
    }
  });

  it('still offers CRUD, which has no Tier-1 equivalent', () => {
    const ops = build(bound).map((d) => d.opId);
    for (const verb of ['read', 'create', 'update', 'delete']) {
      expect(ops).toContain(`contact.${verb}`);
      expect(ops).toContain(`deal.${verb}`);
    }
  });

  it('⚠ an alias with NO Tier-1 tool keeps its search — the rule is derived, not a list', () => {
    // The accounting family has no Tier-1 search, so canonical search survives
    // there. This is what keeps the fan-out reachable rather than dead.
    const withAcct = buildCanonicalOpToolDescriptors({
      boundConnections: [{ name: 'books1', vendor: 'ledgerco' }],
      registry: ACCT_REGISTRY,
    });
    expect(withAcct.map((d) => d.opId)).toContain('invoice.search');
  });
});
