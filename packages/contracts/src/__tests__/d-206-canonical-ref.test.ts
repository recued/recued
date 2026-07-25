/** D-206 step 1 — the canonical RELATIONSHIP declaration (`CanonicalCrmField.ref`).
 *
 *  The whole of D-206's build: three `ref`s on a built-in constant. No table, no writer,
 *  no per-vendor work, no per-pack work — a vendor-asserted relationship is DECLARED and
 *  resolved at READ, never copied into a durable Recued edge.
 *
 *  ## What these tests defend
 *
 *  🔑 **`contact.email` must NEVER become a ref**, and that is the sharpest thing here.
 *  It looks like the obvious fourth member of the set — the canonical schema even
 *  documents it as *"the primary join key against `data.contact.<email>`"* — and adding
 *  it would be a one-line "completion" that any future author might make. It would be
 *  wrong: `vendor.contact` and `data.contact` are the SAME PERSON in two planes
 *  (IDENTITY), not two entities in a relationship. Identity hangs on a MUTABLE key — an
 *  email changes, merges, is promoted from a synthetic placeholder — so it needs a
 *  durable, redirect-able link with a cascade, which already exists
 *  (`contact_platform_link`). Declaring it as a read-time email join would re-introduce
 *  the exact bug D-205 spent an entire arc fixing.
 *
 *  Spec: `docs/d-206-spec.md` §2 (IDENTITY vs RELATIONSHIP). */

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_CRM_FIELD_SCHEMA,
  CRM_ALIAS_VALUES,
  type CanonicalCrmField,
  type CrmAlias,
} from '../connection-vendors.js';

const fieldsOf = (alias: CrmAlias): ReadonlyArray<CanonicalCrmField> =>
  CANONICAL_CRM_FIELD_SCHEMA[alias];

const fieldNamed = (alias: CrmAlias, name: string): CanonicalCrmField => {
  const f = fieldsOf(alias).find((x) => x.name === name);
  if (!f) throw new Error(`canonical ${alias}.${name} does not exist`);
  return f;
};

/** Every declared ref in the schema, as `(alias, field, target)`. */
const allRefs = (): Array<{ alias: CrmAlias; field: string; target: CrmAlias }> =>
  CRM_ALIAS_VALUES.flatMap((alias) =>
    fieldsOf(alias)
      .filter((f) => f.ref !== undefined)
      .map((f) => ({ alias, field: f.name, target: f.ref!.entity })),
  );

describe('D-206 — the canonical relationship declaration', () => {
  it('declares EXACTLY the three relationship refs, and no others', () => {
    // The complete relationship set, and the whole build. A fourth ref appearing here
    // without a spec amendment means someone "completed the set" — most likely with
    // `contact.email`, which is the one thing that must never be a ref (below).
    expect(allRefs().sort((a, b) => `${a.alias}.${a.field}`.localeCompare(`${b.alias}.${b.field}`)))
      .toEqual([
        { alias: 'contact', field: 'account_id', target: 'account' },
        { alias: 'deal', field: 'account_id', target: 'account' },
        { alias: 'deal', field: 'contact_id', target: 'contact' },
      ]);
  });

  it('⛔ contact.email is NOT a ref — identity is not a relationship', () => {
    // 🔑 THE test. `contact.email` is the obvious-looking fourth member, and adding it
    // would be a plausible one-line "fix". It is the bug.
    //
    // `vendor.contact` and `data.contact` are the SAME PERSON in two planes = IDENTITY.
    // It hangs on a MUTABLE key (an email changes / merges / is promoted from a
    // synthetic), so it needs a DURABLE, redirect-able link with a cascade — which
    // already exists (`contact_platform_link`, auto-written by the contact Source sync).
    // A read-time email join would silently break on every address mutation: the exact
    // class of bug D-205 spent an entire arc fixing.
    const email = fieldNamed('contact', 'email');
    expect(email.ref).toBeUndefined();
    // And it really is there — so this is a live assertion about a real field, not a
    // vacuous pass over a field that got renamed away.
    expect(email.required).toBe(true);
  });

  it('every ref targets a crm_alias that EXISTS and actually has fields', () => {
    // A ref to an unknown alias would be a dangling pointer that resolves to nothing —
    // and a relationship that silently is not there is worse than one that is absent.
    const refs = allRefs();
    expect(refs.length).toBeGreaterThan(0); // the sweep must never pass vacuously
    for (const r of refs) {
      expect(CRM_ALIAS_VALUES).toContain(r.target);
      expect(fieldsOf(r.target).length).toBeGreaterThan(0);
    }
  });

  it('a ref field is a STRING — it carries the vendor’s own record id, not a structure', () => {
    // The value is the vendor's raw record id. It is what makes a read-time resolve
    // correct (an opaque, STABLE key) and what makes it join to
    // `ContactRecord.platform_ids[].platform_id` in one hop.
    for (const r of allRefs()) {
      expect(fieldNamed(r.alias, r.field).type).toBe('string');
    }
  });

  it('the deal→contact ref exists BECAUSE Pipedrive models it as a property', () => {
    // The claim that started D-206, and the one an earlier draft of the spec got WRONG by
    // generalizing from HubSpot + Salesforce: whether a relationship is a PROPERTY is PER
    // VENDOR. Pipedrive holds it as `person_id`; HubSpot serves it from an association
    // endpoint and Salesforce from the OpportunityContactRole junction — so neither maps
    // this field, and that ABSENCE is itself the declaration that they have no property
    // route (which is why the association half belongs to the de-hardcode scope, not here).
    const contactId = fieldNamed('deal', 'contact_id');
    expect(contactId.ref).toEqual({ entity: 'contact' });
    // Optional, precisely because two of the three vendors cannot satisfy it.
    expect(contactId.required).toBe(false);
  });
});
