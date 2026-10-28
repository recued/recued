/** D-327 follow-on — the owner-facing text for every Recued switch on a contract.
 *
 *  ⛔ COMPLETE OR IT IS NOT A GUIDE. The Contracts page and the public docs page are
 *  both built from `grant-switch-guide.ts`; a switch without an entry reaches the
 *  owner as a bare id, which is the complaint this exists to answer ("each op should
 *  have a tooltip … for the work/work-entity requirement it is unclear").
 *
 *  ⛔ A NEED MUST BE SOMETHING AN AGREEMENT CAN SWITCH ON. An AI tool's `needs` tells
 *  the owner what else to allow. A need that no agreement can grant (an op kept off
 *  every door, or a name that is not a switch) would send them looking for a control
 *  that does not exist. */

import { describe, expect, it } from 'vitest';

import { TIER1_TOOL_NAMES } from '../chat.js';
import {
  COLLECTION_GUIDE,
  KERNEL_OP_GUIDE,
  TIER1_TOOL_GUIDE,
  grantSwitchText,
  toolsNeedingSwitch,
  tier1CallDetails,
  tier1CallTitle,
} from '../grant-switch-guide.js';
import { collectionGrantEntry, primitiveGrantEntry } from '../grant-entry.js';
import { SITUATION_HISTORY_COLLECTIONS } from '../grant-resolve.js';
import { isGrantableKernelOp, isRegisteredKernelOp, KERNEL_OP_REGISTRY } from '../kernel-op-registry.js';
import { READABLE_COLLECTIONS } from '../read-collection-grant.js';

const SWITCHABLE_COLLECTIONS: readonly string[] = [...READABLE_COLLECTIONS, ...SITUATION_HISTORY_COLLECTIONS];

const allTexts = (): Array<{ key: string; title: string; summary: string; note?: string }> => [
  ...Object.entries(KERNEL_OP_GUIDE).map(([key, v]) => ({ key, ...v })),
  ...Object.entries(TIER1_TOOL_GUIDE).map(([key, v]) => ({
    key, title: v.title, summary: v.summary, ...(v.note !== undefined ? { note: v.note } : {}),
  })),
  ...Object.entries(COLLECTION_GUIDE).map(([key, v]) => ({ key, ...v })),
];

const sentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const words = (sentence: string): number => sentence.split(/\s+/).filter(Boolean).length;

describe('grant switch guide — complete', () => {
  it('has text for every Recued operation, and for nothing else', () => {
    const ops = KERNEL_OP_REGISTRY.map((k) => k.op).sort();
    expect(Object.keys(KERNEL_OP_GUIDE).sort()).toEqual(ops);
  });

  it('has text for every AI tool, and for nothing else', () => {
    expect(Object.keys(TIER1_TOOL_GUIDE).sort()).toEqual([...TIER1_TOOL_NAMES].sort());
  });

  it('has text for every collection a contract can switch, and for nothing else', () => {
    expect(Object.keys(COLLECTION_GUIDE).sort()).toEqual([...SWITCHABLE_COLLECTIONS].sort());
  });
});

describe('grant switch guide — every need is a switch an agreement can turn on', () => {
  for (const [tool, guide] of Object.entries(TIER1_TOOL_GUIDE)) {
    for (const need of guide.needs) {
      it(`${tool} → ${need.entry}`, () => {
        if (need.entry.startsWith('data.')) {
          expect(SWITCHABLE_COLLECTIONS).toContain(need.entry.slice('data.'.length));
          return;
        }
        expect(isRegisteredKernelOp(need.entry)).toBe(true);
        expect(isGrantableKernelOp(need.entry)).toBe(true);
      });
    }
  }

  it('names each need at most once per tool', () => {
    for (const guide of Object.values(TIER1_TOOL_GUIDE)) {
      const entries = guide.needs.map((n) => n.entry);
      expect(new Set(entries).size).toBe(entries.length);
    }
  });
});

describe('grant switch guide — plain enough for the page and the docs', () => {
  it('keeps every title short and unpunctuated', () => {
    for (const { key, title } of allTexts()) {
      expect(title.length, key).toBeGreaterThan(0);
      expect(title.length, `${key}: ${title}`).toBeLessThanOrEqual(42);
      expect(title, key).not.toMatch(/[.;:]$/);
    }
  });

  it('writes every summary and note as whole, short sentences', () => {
    for (const { key, summary, note } of allTexts()) {
      for (const text of [summary, ...(note !== undefined ? [note] : [])]) {
        expect(text, key).toMatch(/[.]$/);
        // The docs style: no semicolons, and no dash joining two clauses.
        expect(text, key).not.toMatch(/;| — | – /);
        for (const sentence of sentences(text)) {
          expect(words(sentence), `${key}: ${sentence}`).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it('never shows the owner an internal word the docs style replaces', () => {
    // `STYLE.md` swaps these out on every public page; a tooltip is a public page.
    const banned = /\b(warehouse|tombstone|idempotent|upsert|canonical|FTS5|SQLite|CAS|hot[- ]field|dispatch|invoke|execute|persist|utili[sz]e)\b/i;
    for (const { key, title, summary, note } of allTexts()) {
      expect(`${title} ${summary} ${note ?? ''}`, key).not.toMatch(banned);
    }
  });
});

describe('grant switch guide — lookups', () => {
  it('finds the text for each kind of entry key', () => {
    expect(grantSwitchText('core.work-entity.task.create')?.title).toBe('Create a task');
    expect(grantSwitchText(primitiveGrantEntry('work.create'))?.title).toBe('Add a task, note or more');
    expect(grantSwitchText(collectionGrantEntry('task'))?.title).toBe('Your tasks');
  });

  it('has no text for a pack op, a recipe or a topic, which carry their own', () => {
    expect(grantSwitchText('recued-core.quickbooks.invoice.read')).toBeUndefined();
    expect(grantSwitchText('recipe.recued-core/overdue-invoice-chase')).toBeUndefined();
    expect(grantSwitchText('enrichment.deal_risk')).toBeUndefined();
    // An inherited Object member is not an op.
    expect(grantSwitchText('constructor')).toBeUndefined();
  });

  it('answers which AI tools stop working when a switch goes off', () => {
    expect(toolsNeedingSwitch('core.work-entity.task.create')).toEqual([
      { tool: 'work.create', when: 'to add tasks' },
    ]);
    expect(toolsNeedingSwitch('core.work-entity.read').map((n) => n.tool).sort()).toEqual(['work.read', 'work.search']);
    expect(toolsNeedingSwitch('core.memory.write').map((n) => n.tool).sort()).toEqual(['memory.forget', 'memory.write']);
    // D-325 — adding things you own is also what lets an AI look up their types.
    expect(toolsNeedingSwitch('core.work-entity.asset.create')).toEqual([
      { tool: 'work.type' },
      { tool: 'work.create', when: 'to add things you own' },
    ]);
    expect(toolsNeedingSwitch('core.mail.send')).toEqual([]);
  });
});

describe('tier1CallTitle — one call of an AI tool, in the owner\'s words', () => {
  it('names the kind of thing a work tool adds or changes', () => {
    expect(tier1CallTitle('work.create', { kind: 'task', title: 'Call the dentist' })).toBe('Add a task');
    expect(tier1CallTitle('work.create', { kind: 'asset', title: 'Road bike' })).toBe('Add a thing you own');
    expect(tier1CallTitle('work.update', { kind: 'asset', id: 'a1', readings: {} })).toBe('Change a thing you own');
    expect(tier1CallTitle('work.update', { kind: 'commitment', id: 'c1' })).toBe('Change a commitment');
    expect(tier1CallTitle('work.update', { kind: 'task', id: 't1', done: true })).toBe('Tick a task off');
    expect(tier1CallTitle('work.update', { kind: 'task', id: 't1', done: false })).toBe('Change a task');
  });

  it('keeps the tool\'s own title where the call names no kind it knows, or the tool has none', () => {
    expect(tier1CallTitle('work.create', {})).toBe('Add a task, note or more');
    expect(tier1CallTitle('work.update', { kind: 'booking' })).toBe('Change a task, note or more');
    expect(tier1CallTitle('work.update', null)).toBe('Change a task, note or more');
    expect(tier1CallTitle('calendar.create', { kind: 'task' })).toBe('Add a calendar event');
    expect(tier1CallTitle('mail.send', {})).toBeUndefined();
    expect(tier1CallTitle('toString', {})).toBeUndefined();
  });
});

describe('tier1CallDetails — a held call\'s arguments as its approval lists them', () => {
  it('names the record a call changes as what it is, and leaves a work call\'s kind to its title', () => {
    // ⛔ Live (2026-10-25): the ask read "kind: asset" and "id: Family car" under "Change a
    // thing you own".
    expect(tier1CallDetails('work.update', { kind: 'asset', id: 'a1', readings: { odometer: 1 } }, { id: { a1: 'Family car' } }))
      .toEqual({ args: { Thing: 'a1', readings: { odometer: 1 } }, labels: { Thing: { a1: 'Family car' } } });
    expect(tier1CallDetails('work.create', { kind: 'asset', title: 'Lock', belongs_to: 'b1' }, { belongs_to: { b1: 'Road bike' } }))
      .toEqual({ args: { title: 'Lock', 'Part of': 'b1' }, labels: { 'Part of': { b1: 'Road bike' } } });
    expect(tier1CallDetails('work.update', { kind: 'task', id: 't1', done: true })).toEqual({ args: { Task: 't1', done: true } });
    expect(tier1CallDetails('calendar.update', { source_id: 'e1', summary: 'Dentist' }, { source_id: { e1: 'Dentist, 10:00' } }))
      .toEqual({ args: { Event: 'e1', summary: 'Dentist' }, labels: { Event: { e1: 'Dentist, 10:00' } } });
  });

  it('leaves what it cannot name as the call has it', () => {
    // A kind no title names keeps its row.
    expect(tier1CallDetails('work.update', { kind: 'booking', id: 'b1' })).toEqual({ args: { kind: 'booking', id: 'b1' } });
    expect(tier1CallDetails('memory.forget', { id: 'm1' }, { id: { m1: 'M' } })).toEqual({ args: { id: 'm1' }, labels: { id: { m1: 'M' } } });
    // Only a work tool's title says its kind.
    expect(tier1CallDetails('calendar.create', { kind: 'task', id: 'x' })).toEqual({ args: { kind: 'task', id: 'x' } });
    // A key the new name would overwrite keeps its own name, so no value is hidden.
    expect(tier1CallDetails('work.update', { kind: 'asset', id: 'a1', Thing: 'x' }).args).toEqual({ id: 'a1', Thing: 'x' });
    // Names read off a stored hold that are not a record name nothing.
    expect(tier1CallDetails('work.update', { kind: 'asset', id: 'a1' }, null as never)).toEqual({ args: { Thing: 'a1' } });
  });
});
