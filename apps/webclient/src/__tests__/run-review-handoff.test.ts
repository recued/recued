import { describe, expect, it, vi } from 'vitest';
import { focusRunReviewReturn, runReviewHref } from '../logs/run-review.js';
import {
  parseDataEntityVerificationAddress, parseLogsRunAddress, parseShellRoute,
  parseSourceRecordAddress, parseSourceRecordVerificationAddress,
  runReviewWorkspaceHref, serializeDataEntityVerificationAddress,
  serializeSourceRecordAddress, serializeSourceRecordVerificationAddress,
  type RunReviewWorkspace,
} from '../shell/route.js';

const workspaces: RunReviewWorkspace[] = [
  { surface: 'recipes', recipeId: 'publisher/recipe?quoted="yes"#tail' },
  { surface: 'packs', packId: 'pack/with?delimiters#tail' },
  { surface: 'approvals', proposalId: 'proposal/with?delimiters#tail' },
];

describe('Exact-run review handoffs', () => {
  for (const workspace of workspaces) {
    it(`retains its ${workspace.surface} origin through a deep link and every item-check address`, () => {
      const address = { runId: 'run/with?delimiters#tail', returnToWorkspace: workspace };
      const href = runReviewHref(address.runId, { returnToWorkspace: workspace });
      expect(parseLogsRunAddress(parseShellRoute(href!))).toEqual(address);
      const source = parseShellRoute(runReviewWorkspaceHref(workspace)!);
      expect(source.surface).toBe(workspace.surface);
      expect(source.segments).toEqual(workspace.surface === 'recipes' ? [workspace.recipeId]
        : workspace.surface === 'packs' ? [workspace.packId] : ['preapproval', workspace.proposalId]);

      const entity = serializeDataEntityVerificationAddress({ tab: 'contact', entityId: 'person/one', returnToRun: address });
      expect(parseDataEntityVerificationAddress(parseShellRoute(entity))?.returnToRun).toEqual(address);
      const exact = serializeSourceRecordAddress({ tab: 'mail', collectionSlug: 'work', recordId: 'message/one', returnToRun: address });
      expect(parseSourceRecordAddress(parseShellRoute(exact))?.returnToRun).toEqual(address);
      const resolved = serializeSourceRecordVerificationAddress({ tab: 'calendar', recordId: 'event/one', returnToRun: address });
      expect(parseSourceRecordVerificationAddress(parseShellRoute(resolved))?.returnToRun).toEqual(address);
    });
  }

  it.each([undefined, '', ' \n\t ', 'active', 'recipe'])('does not invent an exact run from %j', runId => {
    expect(runReviewHref(runId)).toBeNull();
  });

  it.each([
    '#logs/run-1/return/connections',
    '#logs/run-1/return/https/example.com',
    '#logs/run-1/return/recipes',
    '#logs/run-1/return/recipes/%20',
    '#logs/run-1/return/packs/pack-1/run',
    '#logs/run-1/return/approvals/approve',
    '#logs/run-1/return/approvals/preapproval/proposal/decide/approve',
  ])('rejects unsupported or action-bearing return tails (%s)', href => {
    expect(parseLogsRunAddress(parseShellRoute(href))).toBeNull();
  });

  it('drops an empty workspace target while keeping the recorded run addressable', () => {
    const workspace = { surface: 'recipes', recipeId: '' } as const;
    expect(runReviewWorkspaceHref(workspace)).toBeUndefined();
    expect(runReviewHref('run-1', { returnToWorkspace: workspace })).toBe('#logs/run-1');
  });

  it('never lets a previous address in the return context replace the current run', () => {
    const previous = { runId: 'run-previous', returnToWorkspace: { surface: 'packs', packId: 'pack-1' } } as const;
    expect(runReviewHref('run-current', previous)).toBe('#logs/run-current/return/packs/pack-1');
  });
});

describe('Keyboard return to the source workspace', () => {
  const fixture = () => {
    const events = new EventTarget();
    const body = { isConnected: true };
    let active = body;
    let current = true;
    let release!: () => void;
    const loaded = new Promise<void>(resolve => { release = resolve; });
    const heading = { setAttribute: vi.fn(), focus: vi.fn() };
    Object.defineProperties(events, {
      activeElement: { get: () => active }, body: { value: body },
    });
    const opts = {
      document: events as unknown as Document,
      root: { querySelector: () => heading } as unknown as HTMLElement,
      fromHash: '#logs/run-1/return/recipes/recipe-1', toHash: '#recipes/recipe-1',
      whenLoaded: vi.fn(() => loaded), isCurrent: () => current,
    };
    return { opts, heading, release, events,
      moveFocus: () => { active = { isConnected: true }; },
      navigateAway: () => { current = false; } };
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

  it('waits for the workspace read before placing focus in the view', async () => {
    const f = fixture(); focusRunReviewReturn(f.opts);
    expect(f.heading.focus).not.toHaveBeenCalled();
    f.release(); await settle();
    expect(f.heading.focus).toHaveBeenCalledOnce();
    expect(f.heading.setAttribute).toHaveBeenCalledWith('tabindex', '-1');
  });

  it('does not claim an unrelated destination', async () => {
    const f = fixture(); focusRunReviewReturn({ ...f.opts, toHash: '#recipes/other' });
    f.release(); await settle();
    expect(f.opts.whenLoaded).not.toHaveBeenCalled();
    expect(f.heading.focus).not.toHaveBeenCalled();
  });

  it('keeps a focus target already restored by the route', async () => {
    const f = fixture(); focusRunReviewReturn(f.opts); f.moveFocus();
    f.release(); await settle();
    expect(f.heading.focus).not.toHaveBeenCalled();
  });

  for (const gesture of ['keydown', 'pointerdown']) {
    it(`keeps the owner's newer ${gesture} choice while the read is pending`, async () => {
      const f = fixture(); focusRunReviewReturn(f.opts);
      f.events.dispatchEvent(new Event(gesture));
      f.release(); await settle();
      expect(f.heading.focus).not.toHaveBeenCalled();
    });
  }

  it('retires an explicitly cancelled pending return', async () => {
    const f = fixture(); const cancel = focusRunReviewReturn(f.opts); cancel();
    f.release(); await settle();
    expect(f.heading.focus).not.toHaveBeenCalled();
  });

  it('ignores an old read after the active route changes', async () => {
    const f = fixture(); focusRunReviewReturn(f.opts); f.navigateAway();
    f.release(); await settle();
    expect(f.heading.focus).not.toHaveBeenCalled();
  });

  it('can orient the owner in a rendered read-error view', async () => {
    const f = fixture(); focusRunReviewReturn({ ...f.opts, whenLoaded: async () => { throw new Error('Read failed'); } });
    await settle();
    expect(f.heading.focus).toHaveBeenCalledOnce();
  });
});
