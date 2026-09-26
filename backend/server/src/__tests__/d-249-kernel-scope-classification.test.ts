/** D-249 — every grantable kernel op's scope, classified and pinned.
 *
 *  ⛔⛔ THE DEFECT THIS RATCHETS: `deriveDispatchScope` manufactured
 *  `data.<leading-segment>` for `kind: 'storage'`, and on a KERNEL ingredient
 *  that kind means "routed by the kernel adapter", not "touches a collection".
 *  37 grantable ops therefore derived a `data.<x>` — `data.peer`, `data.seller`,
 *  `data.work` — that appears in no namespace table and can appear in no grant
 *  row.
 *
 *  ⛔⛔ AND THE FENCE WAS INVERTED, which is the part that made it a defect
 *  rather than an oddity. An unmatched scope denies at a fenced door, but
 *  `scopeRestrictionsFromReadableCollections` returns `[]` when EVERY collection
 *  is granted, and an empty list ADMITS. So granting a peer a NARROW set denied
 *  these ops and granting them EVERYTHING admitted them: narrowing the grant was
 *  what broke an op that touches no collection.
 *
 *  🔑 THIS FILE IS A CENSUS, NOT A SAMPLE. Four hand-written special cases had
 *  already been added to that function one at a time — `data-file-read`,
 *  `form-response-*`, `timeline-read`, the annotation sidecar — each by someone
 *  who hit it and concluded their case was special. Pinning EVERY op is what
 *  turns the fifth discovery into a red instead of a fifth special case.
 *
 *  ⚠ AND IT ASSERTS THE CLASSIFICATION, NOT A COUNT. A count moves whenever the
 *  registry grows and says nothing about which op moved; the three buckets below
 *  name every member, so a new kernel op lands in one visibly. */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  READABLE_COLLECTIONS,
  deriveDispatchScope,
  evaluateScopeRestrictions,
  isGrantableKernelOp,
  scopeRestrictionsFromReadableCollections,
} from '@recued/contracts';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

/** The widest fence a door can carry while still BEING fenced: every readable
 *  collection and every keep-pattern. Built by hand because granting them all
 *  through the helper collapses to `[]`, which fences nothing — the very
 *  asymmetry that made the old behaviour inverted. */
const MAXIMAL_FENCE: readonly string[] = [
  ...scopeRestrictionsFromReadableCollections(
    new Set(READABLE_COLLECTIONS.filter((c) => c !== 'webhook')),
  ),
  'data.webhook.*',
];

interface Row { readonly op: string; readonly slug: string; readonly scope: string | null }

const rows = (input?: Record<string, unknown>): Row[] => {
  const bySlug = new Map(KERNEL_MANIFESTS.map((m) => [m.slug, m]));
  const out: Row[] = [];
  for (const entry of KERNEL_OP_REGISTRY) {
    const slug = (entry as { backing_slug?: string }).backing_slug;
    if (typeof slug !== 'string' || !isGrantableKernelOp(entry.op)) continue;
    const manifest = bySlug.get(slug);
    if (manifest === undefined) continue;
    out.push({ op: entry.op, slug, scope: deriveDispatchScope({ kind: manifest.kind, slug }, input) });
  }
  return out;
};

const admitted = (scope: string | null): boolean =>
  scope === null || evaluateScopeRestrictions(MAXIMAL_FENCE, scope).verdict === 'admit';

describe('D-249 — kernel op scope classification', () => {
  it('⛔⛔ NO grantable kernel op derives a scope the maximal fence cannot match', () => {
    // ⚠ REPRESENTATIVE ARGS, because several ops carry their collection in the
    // args and DENY without them — which is correct fail-closed behaviour for a
    // malformed call, not the defect. Running the census argument-less would mix
    // "cannot be classified from this call" in with "names a collection that
    // does not exist", and those need opposite fixes.
    const stuck = rows({
      kind: 'task',
      target_collection: 'contact',
      target: 'data.contact:jane@acme.example',
      // `timeline-read` names the entity as `<collection>:<id>` on `entity`.
      entity: 'contact:jane@acme.example',
    })
      .filter((r) => !admitted(r.scope))
      .map((r) => `${r.op} => ${String(r.scope)}`)
      .sort();
    // ⛔ THE TWO DELIBERATE EXCLUSIONS, named so each is a decision on the record
    // rather than a silence:
    //
    //  - the LINK family — a link spans two records in two collections and this
    //    fence carries ONE path, so admitting it on either end would let one
    //    collection's grant reach every other. That is the hazard the annotation
    //    sidecar note describes; expressing a PAIR is a design change, not a list
    //    entry.
    //  - `notify-booking-visitor` — reads a BOOKING and sends MAIL. Scoping it to
    //    `data.mail` would let a door granted mail but not bookings email a
    //    booking's details out; scoping it to `data.booking` would understate the
    //    send. Same two-collection problem, same answer: it stays denied at a
    //    fenced door until the fence can say both.
    expect(stuck).toEqual([
      'core.mail.notify-booking-visitor => data.notify',
      'core.memory.link.create => data.link',
      'core.memory.link.delete => data.link',
      'core.memory.link.list => data.link',
    ]);
  });

  it('⛔ and WITHOUT its collection arg, an arg-scoped op still denies (fail closed)', () => {
    // The other half of the rule above: `work-entity-get` is admitted when the
    // call names `kind` and denied when it does not. A fix that admitted the
    // arg-less call would have traded a wrong denial for a wrong admission.
    const argless = rows().find((r) => r.op === 'core.work-entity.get');
    expect(argless?.scope).toBe('data.work');
    expect(admitted(argless?.scope ?? null)).toBe(false);
  });

  it('✅ an op whose collection arrives in the ARGS is fenced by that collection', () => {
    // `work-entity-*` derived `data.work` and was denied to a door that held
    // `data.task` — the collection was in `kind` all along.
    const withKind = rows({ kind: 'task' });
    const get = withKind.find((r) => r.op === 'core.work-entity.get');
    expect(get?.scope).toBe('data.task');
    expect(admitted(get?.scope ?? null)).toBe(true);
  });

  it('⛔ …and a caller cannot name a keep-pattern family to widen itself', () => {
    // The check the annotation sidecar already makes, for the same reason: an
    // unchecked `kind` would let `memory` derive a family the fence admits
    // unconditionally. Unknown values fall through to the generic rule.
    const sneaky = rows({ kind: 'memory' }).find((r) => r.op === 'core.work-entity.get');
    expect(sneaky?.scope).toBe('data.work');
  });

  it('✅ an op that writes no governed collection declares NO scope, not a fake one', () => {
    const byOp = new Map(rows().map((r) => [r.op, r.scope]));
    for (const op of [
      'core.peer.ask',
      'core.schedule.recipe',
      'core.storage.exchange.status',
      'core.seller.order.get',
      'core.seller.customer-access.issue',
    ]) {
      expect(byOp.get(op), op).toBeNull();
    }
  });

  /** ⛔ The CSV ops read FILE CONTENT — a named instance by `{slug, path}`, or a
   *  `data.file.received` record by `record_id` — so they face the `data.file`
   *  fence, as `file.read` and `data-file-read` do. They used to abstain ("a
   *  passed record handle, not a collection"), which D-245's named address made
   *  false: a door fenced away from files could read one through a CSV op. It
   *  adds no grant: the ops' entity is `file`, so the one Files toggle that
   *  grants them writes the `data.file` row as well. */
  it('⛔ the CSV ops are fenced as data.file — a door without files cannot read one through them', () => {
    const csv = rows().filter((r) => r.op.startsWith('core.storage.csv.'));
    expect(csv.map((r) => r.op).sort()).toEqual([
      'core.storage.csv.columns', 'core.storage.csv.filter', 'core.storage.csv.rows', 'core.storage.csv.stats',
    ]);
    for (const r of csv) expect(r.scope, r.op).toBe('data.file');
    const contactsOnly = scopeRestrictionsFromReadableCollections(new Set(['contact']));
    const withFiles = scopeRestrictionsFromReadableCollections(new Set(['contact', 'file']));
    expect(evaluateScopeRestrictions(contactsOnly, 'data.file').verdict).toBe('deny');
    expect(evaluateScopeRestrictions(withFiles, 'data.file').verdict).toBe('admit');
  });

  it('⚠ `null` is the scope axis abstaining — it is not an authorization', () => {
    // Stated as a test so the widening cannot be read as a relaxation: these ops
    // still need an explicit `contract_grant` row naming them, and still face
    // `admitByOpRisk`, where a `write` op at a delegated door's `read` ceiling
    // resolves to `ask`. This assertion pins the FENCE's own contract: an empty
    // restriction list admits, so a `null` scope was never the thing holding
    // them back at an unfenced door either.
    expect(evaluateScopeRestrictions([], 'data.anything').verdict).toBe('admit');
    expect(evaluateScopeRestrictions(MAXIMAL_FENCE, 'data.mail').verdict).toBe('admit');
    expect(evaluateScopeRestrictions(MAXIMAL_FENCE, 'data.peer').verdict).toBe('deny');
  });
});
