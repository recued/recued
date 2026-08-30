/** The entity axis — `KernelOpEntry.entity` + `TIER1_TOOL_ENTITY` — and the panel
 *  grouping it exists for: ONE section per entity, spanning both registries, so an
 *  owner answers "what can reach my files?" by reading one heading.
 *
 *  ⛔ THE CONTIGUITY TEST IS THE ONE THAT EARNS ITS PLACE. `renderKindGroup` groups by
 *  RUN-LENGTH, so it silently renders a heading twice if same-group entries are not
 *  adjacent — and two "Files" sections look like two legitimate sections in the DOM.
 *  Domain grouping satisfied adjacency by accident (the registry is written
 *  domain-by-domain); entity grouping does not, because kernel ops and Tier-1
 *  primitives come from different loops. */

import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_REGISTRY,
  WORK_ENTITY_KINDS,
  OP_ENTITIES,
  OP_ENTITY_LABEL,
  OP_ENTITY_SET,
  TIER1_TOOL_ENTITY,
  TIER1_TOOL_NAMES,
} from '@recued/contracts';

import { _testing } from '../contracts/contract-grants-panel.js';

const universe = () => _testing.buildUniverse(undefined, undefined, undefined);
const opEntries = () => universe().filter((e) => e.kind === 'op');

describe('every op is annotated with an entity', () => {
  it('every kernel op carries an entity in the closed vocabulary', () => {
    // ⚠ Runtime, not just the type: a `satisfies`-free cast anywhere in the registry
    // would compile and land an op in a group the panel cannot label.
    const bad = KERNEL_OP_REGISTRY.filter((k) => !OP_ENTITY_SET.has(k.entity));
    expect(bad.map((k) => `${k.op}=${String(k.entity)}`)).toEqual([]);
    expect(KERNEL_OP_REGISTRY.length).toBeGreaterThan(100);
  });

  it('every Tier-1 primitive carries one too', () => {
    const bad = TIER1_TOOL_NAMES.filter((n) => !OP_ENTITY_SET.has(TIER1_TOOL_ENTITY[n]));
    expect(bad).toEqual([]);
  });

  it('every entity has an owner-facing label', () => {
    const unlabelled = OP_ENTITIES.filter((e) => (OP_ENTITY_LABEL[e] ?? '').length === 0);
    expect(unlabelled).toEqual([]);
  });

  /** ⚠ An entity nothing uses is either a leftover from a rename or a group heading an
   *  owner will never see — both worth knowing about at the moment it happens. */
  it('no entity is orphaned across BOTH registries', () => {
    const used = new Set<string>([
      ...KERNEL_OP_REGISTRY.map((k) => k.entity),
      ...TIER1_TOOL_NAMES.map((n) => TIER1_TOOL_ENTITY[n]),
    ]);
    expect(OP_ENTITIES.filter((e) => !used.has(e))).toEqual([]);
  });
});

describe('the panel renders one group per entity', () => {
  it('op-kind entries are ordered so each group is CONTIGUOUS', () => {
    const groups = opEntries().map((e) => e.group);
    const seen = new Set<string>();
    const reopened: string[] = [];
    let current: string | null = null;
    for (const g of groups) {
      if (g === current) continue;
      if (seen.has(g)) reopened.push(g);
      seen.add(g);
      current = g;
    }
    // A non-empty list here is a heading the panel prints twice.
    expect(reopened).toEqual([]);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('a kernel op and a chat primitive over the same data share ONE group', () => {
    const byLabel = new Map(opEntries().map((e) => [e.label, e.group]));
    // The exact pair this whole axis exists for.
    expect(byLabel.get('core.storage.file.read')).toBe(OP_ENTITY_LABEL.file);
    expect(byLabel.get('file.search')).toBe(OP_ENTITY_LABEL.file);
    expect(byLabel.get('core.mail.send')).toBe(OP_ENTITY_LABEL.mail);
    expect(byLabel.get('mail.search')).toBe(OP_ENTITY_LABEL.mail);
  });

  it('the "always-on tools" heading is gone — those rows are ordinary grants', () => {
    expect(opEntries().map((e) => e.group)).not.toContain('Assistant · always-on tools');
  });

  it('the Files group holds every file-reaching op, including the ones whose id does not say "file"', () => {
    const files = opEntries().filter((e) => e.group === OP_ENTITY_LABEL.file).map((e) => e.label);
    // ⛔ These three are why the entity is an ANNOTATION and not a parse of the id.
    expect(files).toContain('core.storage.csv.filter');
    expect(files).toContain('core.storage.data-file-read');
    expect(files).toContain('core.storage.file.fetch-remote');
  });
});

describe('the data.* collection axis retired into the entity groups', () => {
  it('a collection fence heads under the SAME entity as the ops over that data', () => {
    const u = universe();
    const byKey = new Map(u.map((e) => [e.entry_key, e]));
    // ⛔ The three controls over one thing, now under one heading.
    expect(byKey.get('data.file')?.group).toBe(OP_ENTITY_LABEL.file);
    expect(byKey.get('data.mail')?.group).toBe(OP_ENTITY_LABEL.mail);
    expect(byKey.get('data.calendar')?.group).toBe(OP_ENTITY_LABEL.calendar);
  });

  it('every work-entity kind fans into ONE Tasks & notes heading', () => {
    const u = universe();
    const workRows = u.filter((e) => e.kind === 'collection'
      && WORK_ENTITY_KINDS.includes(e.entry_key.slice('data.'.length) as never));
    expect(workRows.length).toBe(WORK_ENTITY_KINDS.length);
    expect([...new Set(workRows.map((e) => e.group))]).toEqual([OP_ENTITY_LABEL.work]);
  });

  it('collection groups are CONTIGUOUS too — the same run-length trap', () => {
    const groups = universe().filter((e) => e.kind === 'collection').map((e) => e.group);
    const seen = new Set<string>(); const reopened: string[] = [];
    let current: string | null = null;
    for (const g of groups) {
      if (g === current) continue;
      if (seen.has(g)) reopened.push(g);
      seen.add(g); current = g;
    }
    expect(reopened).toEqual([]);
  });
});
