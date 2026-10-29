/** D-327 follow-on — each AI tool's "needs" on the Contracts page is what its handler
 *  really checks.
 *
 *  ⛔ THE PAGE TELLS THE OWNER WHAT ELSE TO SWITCH ON, SO IT MUST BE TRUE. On an
 *  agreement that grants nothing by default, `work.create` alone adds nothing: the
 *  handler also asks for `core.work-entity.<kind>.create`. The owner could not see
 *  that ("for the work/work-entity requirement it is unclear"), so
 *  `TIER1_TOOL_GUIDE[tool].needs` now says it. A handler that starts checking a
 *  different op, or stops checking one, must change that list. This compares the two
 *  through the handlers' OWN constants, never a copy of their values.
 *
 *  ⚠ EXACT, NOT A SUBSET. A need the handler does not check sends the owner to switch
 *  on something that changes nothing, and they would still be stuck. */

import { describe, expect, it } from 'vitest';
import {
  collectionGrantEntry,
  OP_ENTITY_COLLECTION,
  TIER1_TOOL_ENTITY,
  TIER1_TOOL_GUIDE,
  TIER1_TOOL_NAMES,
  WORK_ENTITY_KINDS,
  type Tier1ToolName,
} from '@recued/contracts';

import {
  ASSET_CREATE_OP_ID,
  ASSET_UPDATE_OP_ID,
  CALENDAR_CREATE_OP_ID,
  CALENDAR_UPDATE_OP_ID,
  FENCED_EMPTY_CONTAINER,
  MEMORY_READ_OP_ID,
  MEMORY_WRITE_OP_ID,
  SCHEDULE_RECIPE_OP_ID,
  TASK_MARK_DONE_OP_ID,
  WORK_ENTITY_CREATE_OP_ID,
  WORK_ENTITY_READ_OP_ID,
  WORK_ENTITY_UPDATE_OP_ID,
} from '../chat-tool-handlers.js';
import { documentReadRecipe } from '../document-read-tool.js';
import { SITUATION_READ_OP } from '../situations/access.js';

const data = (collection: string): string => `data.${collection}`;

/** The table fence (`wrapCollectionFence`) refuses a read tool whose collection is
 *  off. Derived the way the fence derives it: the tool's entity, then its collection. */
const fencedCollection = (tool: string): string[] => {
  if (!(tool in FENCED_EMPTY_CONTAINER)) return [];
  const collection = OP_ENTITY_COLLECTION[TIER1_TOOL_ENTITY[tool as Tier1ToolName]];
  return collection === undefined ? [] : [data(collection)];
};

/** The `core.*` steps of the recipe `document.read` runs: the plain-file read, and the
 *  read of a converted document (the convert step is the converter pack's own op). */
const documentReadOps = (): string[] => [
  ...documentReadRecipe().steps,
  ...documentReadRecipe('markitdown').steps,
].flatMap((step) => {
  const op = (step as { op?: unknown }).op;
  return typeof op === 'string' && op.startsWith('core.') ? [op] : [];
});

/** What each handler checks, beyond the tool's own switch. Literal entries are named
 *  with the place the handler checks them. */
const EXPECTED: Readonly<Record<Tier1ToolName, readonly string[]>> = {
  // `createContactSearchHandler` checks the contact collection for local contacts
  // only (`isCollectionReadGrantedForDispatch(deps, ctx, 'contact')`); a fan-out tool,
  // so it is outside the table fence.
  'contact.search': [data('contact')],
  'contact.read': fencedCollection('contact.read'),
  'mail.search': fencedCollection('mail.search'),
  // + `mail-read-tool.ts` leaves attachments out unless `file` is readable.
  'mail.read': [...fencedCollection('mail.read'), data('file')],
  'document.read': [...fencedCollection('document.read'), ...documentReadOps()],
  'calendar.search': fencedCollection('calendar.search'),
  'memory.search': [MEMORY_READ_OP_ID],
  'memory.write': [MEMORY_WRITE_OP_ID],
  'memory.forget': [MEMORY_WRITE_OP_ID],
  // Per topic (`enrichment.<topic>`): no fixed switch to name.
  'enrichment.search': [],
  // `createDealSearchHandler` leaves the contact of a deal out unless `contact` is readable.
  'deal.search': [data('contact')],
  'account.search': [],
  'work.search': [WORK_ENTITY_READ_OP_ID, ...WORK_ENTITY_KINDS.map(data)],
  'work.read': [WORK_ENTITY_READ_OP_ID, ...WORK_ENTITY_KINDS.map(data)],
  'situation.query': [SITUATION_READ_OP],
  // A type is described for creating one, so `work.type` asks for the asset create.
  'work.type': [ASSET_CREATE_OP_ID],
  'work.create': [...Object.values(WORK_ENTITY_CREATE_OP_ID), ASSET_CREATE_OP_ID],
  'calendar.create': [CALENDAR_CREATE_OP_ID],
  'calendar.update': [CALENDAR_UPDATE_OP_ID],
  'work.update': [...Object.values(WORK_ENTITY_UPDATE_OP_ID), ASSET_UPDATE_OP_ID, TASK_MARK_DONE_OP_ID],
  'file.search': fencedCollection('file.search'),
  // Each step meets its own op gate inside the run; the tool checks nothing first.
  'recipe.run': [],
  'recipe.stop': [],
  'recipe.schedule': [SCHEDULE_RECIPE_OP_ID],
  'schedule.run_prompt': ['core.schedule.prompt'],
  'schedule.list': ['core.schedule.prompt'],
  'schedule.update': ['core.schedule.prompt'],
  'schedule.pause': ['core.schedule.prompt'],
  'schedule.resume': ['core.schedule.prompt'],
  'schedule.remove': ['core.schedule.prompt'],
};

describe('D-327 — the needs the Contracts page shows are what the handlers check', () => {
  for (const tool of TIER1_TOOL_NAMES) {
    it(tool, () => {
      const shown = TIER1_TOOL_GUIDE[tool].needs.map((n) => n.entry).sort();
      expect(shown).toEqual([...new Set(EXPECTED[tool])].sort());
    });
  }

  it('derives the fenced collections rather than trusting an empty list', () => {
    // A rename in the fence's tables would empty `fencedCollection` and pass every
    // fenced tool above against nothing. These four are known to read one collection.
    expect(fencedCollection('mail.search')).toEqual([collectionGrantEntry('mail')]);
    expect(fencedCollection('calendar.search')).toEqual([collectionGrantEntry('calendar')]);
    expect(fencedCollection('file.search')).toEqual([collectionGrantEntry('file')]);
    expect(fencedCollection('contact.read')).toEqual([collectionGrantEntry('contact')]);
    expect(documentReadOps().sort()).toEqual(['core.storage.data-file-read', 'core.storage.file.read-temp']);
  });
});
