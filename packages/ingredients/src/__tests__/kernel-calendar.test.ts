/** D-117 Phase 6 — calendar kernel ingredient routing tests.
 *
 *  Asserts the kernel adapter routes each of the 8 calendar slugs to
 *  the correct dispatcher slot, threads the input through verbatim,
 *  and surfaces SERVER_NOT_REACHABLE when the slot is missing. */

import { describe, expect, it, vi } from 'vitest';
import { createKernelAdapter, type KernelDispatchers } from '../kernel.js';
import { IngredientError } from '../types.js';

const call = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
});

describe('calendar-* kernel routing (D-117 Phase 6)', () => {
  it('routes calendar-list to dispatchers.calendarList', async () => {
    const calendarList = vi.fn().mockResolvedValue({ records: [] });
    const adapter = createKernelAdapter({ calendarList });
    await adapter(call('calendar-list', { slug: 'work', limit: 10 }));
    expect(calendarList).toHaveBeenCalledWith({ slug: 'work', limit: 10 });
  });

  it('routes calendar-get with { slug, source_id }', async () => {
    const calendarGet = vi.fn().mockResolvedValue({ record: { foo: 'bar' } });
    const adapter = createKernelAdapter({ calendarGet });
    const res = await adapter(call('calendar-get', { slug: 'work', source_id: 'evt-1' }));
    expect(calendarGet).toHaveBeenCalledWith({ slug: 'work', source_id: 'evt-1' });
    // D-119 Phase 12 — kernel adapter stamps `_id` (= source_id when
    // ical_uid is absent) + `_collection: 'calendar'` on the returned
    // record. The dispatcher's `foo: 'bar'` payload is preserved.
    expect(res).toEqual({
      record: { _id: 'evt-1', _collection: 'calendar', foo: 'bar' },
    });
  });

  it('routes calendar-search through to the search slot', async () => {
    const calendarSearch = vi.fn().mockResolvedValue({ matches: [] });
    const adapter = createKernelAdapter({ calendarSearch });
    await adapter(call('calendar-search', { slug: 'work', query: 'hi' }));
    expect(calendarSearch).toHaveBeenCalledWith({ slug: 'work', query: 'hi' });
  });

  it('routes calendar-stat through to the stat slot', async () => {
    const calendarStat = vi.fn().mockResolvedValue({ exists: false });
    const adapter = createKernelAdapter({ calendarStat });
    const res = await adapter(call('calendar-stat', { slug: 'work', source_id: 'x' }));
    expect(res).toEqual({ exists: false });
  });

  it('routes calendar-create with the full input shape', async () => {
    const calendarCreate = vi.fn().mockResolvedValue({ source_id: 'new', ical_uid: 'u' });
    const adapter = createKernelAdapter({ calendarCreate });
    const event = { summary: 'Meeting' };
    await adapter(
      call('calendar-create', { slug: 'work', calendar_id: 'cal', event }),
    );
    expect(calendarCreate).toHaveBeenCalledWith({
      slug: 'work',
      calendar_id: 'cal',
      event,
    });
  });

  it('routes calendar-update including scope', async () => {
    const calendarUpdate = vi.fn().mockResolvedValue({ source_id: 'evt' });
    const adapter = createKernelAdapter({ calendarUpdate });
    await adapter(
      call('calendar-update', {
        slug: 'work',
        source_id: 'evt',
        patch: { summary: 'x' },
        scope: 'series',
      }),
    );
    expect(calendarUpdate).toHaveBeenCalledWith({
      slug: 'work',
      source_id: 'evt',
      patch: { summary: 'x' },
      scope: 'series',
    });
  });

  it('routes calendar-delete with optional scope', async () => {
    const calendarDelete = vi.fn().mockResolvedValue({ deleted: true });
    const adapter = createKernelAdapter({ calendarDelete });
    await adapter(call('calendar-delete', { slug: 'work', source_id: 'evt' }));
    expect(calendarDelete).toHaveBeenCalledWith({
      slug: 'work',
      source_id: 'evt',
    });
  });

  it('routes calendar-rsvp with response + optional comment', async () => {
    const calendarRsvp = vi.fn().mockResolvedValue({
      source_id: 'evt',
      response_status: 'accepted',
    });
    const adapter = createKernelAdapter({ calendarRsvp });
    await adapter(
      call('calendar-rsvp', {
        slug: 'work',
        source_id: 'evt',
        response: 'accepted',
        comment: 'see you',
      }),
    );
    expect(calendarRsvp).toHaveBeenCalledWith({
      slug: 'work',
      source_id: 'evt',
      response: 'accepted',
      comment: 'see you',
    });
  });

  for (const slug of [
    'calendar-list',
    'calendar-get',
    'calendar-search',
    'calendar-stat',
    'calendar-create',
    'calendar-update',
    'calendar-delete',
    'calendar-rsvp',
  ]) {
    it(`throws SERVER_NOT_REACHABLE when ${slug} dispatcher is missing`, async () => {
      const adapter = createKernelAdapter({});
      try {
        await adapter(call(slug, { slug: 'work' }));
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(IngredientError);
        expect((err as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
        expect((err as IngredientError).message).toMatch(slug);
      }
    });
  }
});
