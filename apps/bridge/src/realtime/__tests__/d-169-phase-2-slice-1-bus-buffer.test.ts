import { describe, expect, it } from 'vitest';

import type { ServerEvent } from '@recued/contracts';
import { createBridgeBusBuffer } from '../bus-buffer.js';

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

describe('D-169 P2 Slice 1 - bridge bus buffer', () => {
  it('maps notification.notify rows with cursor ids, optional title, and injected receipt time', () => {
    let tick = 1_800_000_000_000;
    const buffer = createBridgeBusBuffer({ now: () => tick++ });

    buffer.apply({
      kind: 'notification.notify',
      title: 'Heads up',
      text: 'Body A',
      cursor: 10,
    });
    buffer.apply({
      kind: 'notification.notify',
      text: 'Body B',
      cursor: 11,
    });

    const notifications = buffer.snapshot().notifications;
    expect(notifications).toEqual([
      {
        id: 'notify:11',
        text: 'Body B',
        fired_at: 1_800_000_000_001,
      },
      {
        id: 'notify:10',
        title: 'Heads up',
        text: 'Body A',
        fired_at: 1_800_000_000_000,
      },
    ]);
    expect(hasOwn(notifications[0]!, 'title')).toBe(false);
  });

  it('maps notification.ask options and upserts re-delivery by ask_id newest-first', () => {
    let tick = 1_800_000_000_100;
    const buffer = createBridgeBusBuffer({ now: () => tick++ });
    const firstOptions = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ] as const;

    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-1',
      title: 'Approve?',
      text: 'Original body',
      options: firstOptions,
      cursor: 20,
    });
    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-2',
      text: 'Second body',
      options: [{ id: 'ack', label: 'Acknowledge' }],
      cursor: 21,
    });
    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-1',
      text: 'Updated body',
      options: [{ id: 'later', label: 'Later' }],
      cursor: 22,
    });

    const approvals = buffer.snapshot().approvals;
    expect(approvals).toEqual([
      {
        ask_id: 'ask-1',
        text: 'Updated body',
        options: [{ id: 'later', label: 'Later' }],
        created_at: 1_800_000_000_102,
      },
      {
        ask_id: 'ask-2',
        text: 'Second body',
        options: [{ id: 'ack', label: 'Acknowledge' }],
        created_at: 1_800_000_000_101,
      },
    ]);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]!.options).not.toBe(firstOptions);
    expect(approvals[1]!.options[0]).not.toBe(firstOptions[0]);
    expect(hasOwn(approvals[0]!, 'title')).toBe(false);
  });

  it('removes notification.ask_closed rows by ask_id and ignores absent asks', () => {
    const buffer = createBridgeBusBuffer({ now: () => 1_800_000_000_000 });

    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-1',
      text: 'Keep?',
      options: [{ id: 'ok', label: 'OK' }],
      cursor: 30,
    });
    buffer.apply({
      kind: 'notification.ask_closed',
      ask_id: 'missing',
      cursor: 31,
    });
    expect(buffer.snapshot().approvals.map((a) => a.ask_id)).toEqual(['ask-1']);

    buffer.apply({
      kind: 'notification.ask_closed',
      ask_id: 'ask-1',
      cursor: 32,
    });
    expect(buffer.snapshot().approvals).toEqual([]);
  });

  it('maps only terminal execution events into recipe result rows', () => {
    let tick = 1_800_000_001_000;
    const buffer = createBridgeBusBuffer({ now: () => tick++ });
    const events: ServerEvent[] = [
      {
        kind: 'execution',
        recipe_id: 'recipe-start',
        run_id: 'run-start',
        op: 'start',
        cursor: 40,
      },
      {
        kind: 'execution',
        recipe_id: 'recipe-progress',
        run_id: 'run-progress',
        op: 'progress',
        cursor: 41,
      },
      {
        kind: 'execution',
        recipe_id: 'recipe-ok',
        run_id: 'run-ok',
        op: 'complete',
        cursor: 42,
      },
      {
        kind: 'execution',
        recipe_id: 'recipe-error',
        run_id: 'run-error',
        op: 'error',
        cursor: 43,
      },
    ];

    for (const event of events) buffer.apply(event);

    expect(buffer.snapshot().recipe_results).toEqual([
      {
        run_id: 'run-error',
        recipe_id: 'recipe-error',
        status: 'error',
        started_at: 1_800_000_001_001,
        duration_ms: null,
      },
      {
        run_id: 'run-ok',
        recipe_id: 'recipe-ok',
        status: 'ok',
        started_at: 1_800_000_001_000,
        duration_ms: null,
      },
    ]);
  });

  it('caps each section independently, dropping the oldest and preserving newest-first snapshots', () => {
    let tick = 1_800_000_002_000;
    const buffer = createBridgeBusBuffer({ cap: 2, now: () => tick++ });

    for (let i = 1; i <= 3; i++) {
      buffer.apply({
        kind: 'notification.notify',
        text: `notify-${i}`,
        cursor: i,
      });
      buffer.apply({
        kind: 'notification.ask',
        ask_id: `ask-${i}`,
        text: `ask-${i}`,
        options: [{ id: `opt-${i}`, label: `Option ${i}` }],
        cursor: 10 + i,
      });
      buffer.apply({
        kind: 'execution',
        recipe_id: `recipe-${i}`,
        run_id: `run-${i}`,
        op: 'complete',
        cursor: 20 + i,
      });
    }

    const snapshot = buffer.snapshot();
    expect(snapshot.notifications.map((n) => n.id)).toEqual([
      'notify:3',
      'notify:2',
    ]);
    expect(snapshot.approvals.map((a) => a.ask_id)).toEqual(['ask-3', 'ask-2']);
    expect(snapshot.recipe_results.map((r) => r.recipe_id)).toEqual([
      'recipe-3',
      'recipe-2',
    ]);
  });

  it('reset clears all three sections', () => {
    const buffer = createBridgeBusBuffer({ now: () => 1_800_000_003_000 });

    buffer.apply({
      kind: 'notification.notify',
      text: 'Notice',
      cursor: 50,
    });
    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-1',
      text: 'Question',
      options: [{ id: 'ok', label: 'OK' }],
      cursor: 51,
    });
    buffer.apply({
      kind: 'execution',
      recipe_id: 'recipe-1',
      run_id: 'run-1',
      op: 'complete',
      cursor: 52,
    });

    buffer.reset();

    expect(buffer.snapshot()).toEqual({
      recipe_results: [],
      notifications: [],
      approvals: [],
    });
  });
});


describe('D-234 § 234.3 / § 234.4e — the live frame carries both card fields', () => {
  it('⛔⛔ COPIES `link_url` AND `note_prompt` off the bus frame', () => {
    // ⛔ THIS IS WHERE THE DROP ACTUALLY WAS. The fold below is an enumerating
    // copier: a field it does not name never reaches a live card, and nothing
    // fails — `link_url` was missing here from § 234.3 until 2026-08-11, so an
    // ask that arrived live showed no "read it here" affordance until the next
    // history re-fetch replaced the row. A `'required'` note has the sharper
    // failure: answering such a card in that window no-ops server-side.
    //
    // ⚠ Asserting the RENDERED card is not enough — that path takes an item that
    // already has the fields. Only this asserts they survive the copy.
    const buffer = createBridgeBusBuffer({ now: () => 1_000 });
    const resource_review = {
      schema_version: 1 as const, operation: 'records.upsert', input_hash: 'a'.repeat(64), captured_at: 1000,
      resources: [{ kind: 'records' as const, key: 'new', label: 'New row', binding: 'binding', version: 'absent',
        precondition: { kind: 'records_absent' as const }, before: {}, after: { title: 'Reviewed' } }],
    };
    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-9',
      text: 'Does the Friday deadline read as too firm?',
      options: [{ id: 'yes', label: 'Yes' }],
      link_url: 'https://app.recued.com/#/review/9',
      note_prompt: 'required',
      resource_review,
      cursor: 30,
    });
    const row = buffer.snapshot().approvals[0];
    expect(row?.link_url).toBe('https://app.recued.com/#/review/9');
    expect(row?.note_prompt).toBe('required');
    expect(row?.resource_review).toEqual(resource_review);
  });

  it('omits both when the frame carries neither — an ordinary ask is unchanged', () => {
    const buffer = createBridgeBusBuffer({ now: () => 1_000 });
    buffer.apply({
      kind: 'notification.ask',
      ask_id: 'ask-10',
      text: 'Send it?',
      options: [{ id: 'yes', label: 'Yes' }],
      cursor: 31,
    });
    const row = buffer.snapshot().approvals[0];
    expect(row).not.toHaveProperty('link_url');
    expect(row).not.toHaveProperty('note_prompt');
  });
});
