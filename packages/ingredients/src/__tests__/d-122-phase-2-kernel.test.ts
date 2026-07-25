/** D-122 Phase 2 — kernel adapter tests for the five graph-builder
 *  ingredients: contact-upsert, mail-thread-reader, link-create,
 *  annotation-create, timeline-read.
 *
 *  Covers per-slug input shape normalization (combined `<col>:<id>`
 *  splits), confidence/evidence pass-through, BAD_INPUT on malformed
 *  refs, SERVER_NOT_REACHABLE when the dispatcher slot is absent, and
 *  output canonical-stamping on records that flow back to the recipe
 *  surface. */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import type {
  Annotation,
  ContactRecord,
  Link,
  TimelineEntry,
} from '@recued/contracts';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const mkContact = (overrides: Partial<ContactRecord> = {}): ContactRecord => ({
  _id: 'jane@acme.com',
  _collection: 'contact',
  email: 'jane@acme.com',
  source: 'manual',
  first_seen: 1,
  last_interaction: 1,
  interaction_count: 1,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

const mkLink = (overrides: Partial<Link> = {}): Link => ({
  _id: 'l1',
  _collection: 'link',
  from_collection: 'mail',
  from_id: 'msg-a',
  to_collection: 'contact',
  to_id: 'jane@acme.com',
  role: 'extraction.derived_contact',
  created_at: 1,
  authored_by_recipe_id: 'r1',
  ...overrides,
});

const mkAnnotation = (overrides: Partial<Annotation> = {}): Annotation => ({
  _id: 'a1',
  _collection: 'annotation',
  target_collection: 'contact',
  target_id: 'jane@acme.com',
  key: 'company',
  value: 'Acme',
  authored_by_recipe_id: 'r1',
  source_record_hash: 's',
  recipe_hash: 'r',
  authored_at: 1,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// contact-upsert
// ────────────────────────────────────────────────────────────────

describe('kernel adapter — contact-upsert', () => {
  it('passes email + display_name + last_interaction to the dispatcher', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      contactUpsert: async (input) => {
        captured = input;
        return { contact: mkContact({ email: input.email }) };
      },
    });
    await adapter(
      mkCall('contact-upsert', {
        email: 'jane@acme.com',
        display_name: 'Jane Smith',
        last_interaction: 1234,
      }),
    );
    expect(captured).toEqual({
      email: 'jane@acme.com',
      display_name: 'Jane Smith',
      last_interaction: 1234,
    });
  });

  it('stamps the returned contact with canonical _id + _collection', async () => {
    const adapter = createKernelAdapter({
      contactUpsert: async () => ({
        // Dispatcher returns a raw shape without canonical fields stamped.
        contact: { email: 'jane@acme.com' } as unknown as ContactRecord,
      }),
    });
    const res = await adapter(
      mkCall('contact-upsert', { email: 'jane@acme.com' }),
    ) as { contact: ContactRecord };
    expect(res.contact._id).toBe('jane@acme.com');
    expect(res.contact._collection).toBe('contact');
  });

  it('BAD_INPUT when email missing', async () => {
    const adapter = createKernelAdapter({
      contactUpsert: async () => ({ contact: mkContact() }),
    });
    await expect(
      adapter(mkCall('contact-upsert', {})),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('SERVER_NOT_REACHABLE when dispatcher absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall('contact-upsert', { email: 'jane@acme.com' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});

// ────────────────────────────────────────────────────────────────
// mail-thread-reader
// ────────────────────────────────────────────────────────────────

describe('kernel adapter — mail-thread-reader', () => {
  it('forwards slug + thread_id and stamps messages canonically', async () => {
    const adapter = createKernelAdapter({
      mailThreadRead: async (input) => ({
        messages: [
          {
            record_id: 'mail:abc',
            received_at: 100,
            modified_at: 100,
            hot_fields: { thread_id: input.thread_id, subject: 'hi' },
            size_bytes: 10,
            source_id: 'abc',
          },
        ],
        message_count: 1,
        first_at: 100,
        last_at: 100,
      }),
    });
    const res = await adapter(
      mkCall('mail-thread-reader', {
        slug: 'work',
        thread_id: 'thr-1',
      }),
    ) as {
      messages: Array<{ _id: string; _collection: string; record_id: string }>;
      message_count: number;
      first_at: number;
      last_at: number;
    };
    expect(res.messages[0]._id).toBe('mail:abc');
    expect(res.messages[0]._collection).toBe('mail');
    expect(res.message_count).toBe(1);
    expect(res.first_at).toBe(100);
    expect(res.last_at).toBe(100);
  });

  it('passes max_messages through when supplied', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      mailThreadRead: async (input) => {
        captured = input;
        return { messages: [], message_count: 0, first_at: 0, last_at: 0 };
      },
    });
    await adapter(
      mkCall('mail-thread-reader', {
        slug: 'work', thread_id: 't1', max_messages: 25,
      }),
    );
    expect(captured).toEqual({ slug: 'work', thread_id: 't1', max_messages: 25 });
  });

  it('omits max_messages when zero / negative', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      mailThreadRead: async (input) => {
        captured = input;
        return { messages: [], message_count: 0, first_at: 0, last_at: 0 };
      },
    });
    await adapter(
      mkCall('mail-thread-reader', { slug: 'work', thread_id: 't1', max_messages: 0 }),
    );
    expect((captured as { max_messages?: number }).max_messages).toBeUndefined();
  });

  it('BAD_INPUT when slug missing', async () => {
    const adapter = createKernelAdapter({
      mailThreadRead: async () => ({ messages: [], message_count: 0, first_at: 0, last_at: 0 }),
    });
    await expect(
      adapter(mkCall('mail-thread-reader', { thread_id: 't1' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('BAD_INPUT when thread_id missing', async () => {
    const adapter = createKernelAdapter({
      mailThreadRead: async () => ({ messages: [], message_count: 0, first_at: 0, last_at: 0 }),
    });
    await expect(
      adapter(mkCall('mail-thread-reader', { slug: 'work' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('SERVER_NOT_REACHABLE when dispatcher absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall('mail-thread-reader', { slug: 'work', thread_id: 't1' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});

// ────────────────────────────────────────────────────────────────
// link-create
// ────────────────────────────────────────────────────────────────

describe('kernel adapter — link-create', () => {
  it('splits source/target on first colon → from/to', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkCreate: async (input) => {
        captured = input;
        return { link: mkLink() };
      },
    });
    await adapter(
      mkCall('link-create', {
        source: 'data.mail:msg-abc',
        target: 'data.contact:jane@acme.com',
        kind: 'extraction.derived_contact',
        authored_by_recipe_id: 'r1',
      }),
    );
    expect(captured).toMatchObject({
      from_collection: 'data.mail',
      from_id: 'msg-abc',
      to_collection: 'data.contact',
      to_id: 'jane@acme.com',
      role: 'extraction.derived_contact',
    });
  });

  it('preserves trailing colons in the id half (source_id with colons)', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkCreate: async (input) => {
        captured = input;
        return { link: mkLink() };
      },
    });
    await adapter(
      mkCall('link-create', {
        source: 'data.mail:vendor:order:42',
        target: 'data.contact:foo@bar.com',
        kind: 'extraction.thread_participant',
        authored_by_recipe_id: 'r1',
      }),
    );
    expect((captured as { from_id: string }).from_id).toBe('vendor:order:42');
  });

  it('passes confidence + evidence through to the dispatcher', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      linkCreate: async (input) => {
        captured = input;
        return { link: mkLink({ confidence: input.confidence!, evidence: input.evidence! }) };
      },
    });
    await adapter(
      mkCall('link-create', {
        source: 'data.mail:m1',
        target: 'data.calendar:e1',
        kind: 'extraction.references_event',
        confidence: 0.82,
        evidence: 'matched on subject date + attendee overlap',
        authored_by_recipe_id: 'r1',
      }),
    );
    expect(captured).toMatchObject({ confidence: 0.82, evidence: 'matched on subject date + attendee overlap' });
  });

  it('BAD_INPUT when source missing colon', async () => {
    const adapter = createKernelAdapter({
      linkCreate: async () => ({ link: mkLink() }),
    });
    await expect(
      adapter(mkCall('link-create', {
        source: 'no-colon',
        target: 'data.contact:x',
        kind: 'extraction.x',
        authored_by_recipe_id: 'r1',
      })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('BAD_INPUT when kind missing', async () => {
    const adapter = createKernelAdapter({
      linkCreate: async () => ({ link: mkLink() }),
    });
    await expect(
      adapter(mkCall('link-create', {
        source: 'data.mail:m1', target: 'data.contact:x',
        authored_by_recipe_id: 'r1',
      })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('SERVER_NOT_REACHABLE when dispatcher absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall('link-create', {
        source: 'data.mail:m1', target: 'data.contact:x',
        kind: 'extraction.x', authored_by_recipe_id: 'r1',
      })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});

// ────────────────────────────────────────────────────────────────
// annotation-create
// ────────────────────────────────────────────────────────────────

describe('kernel adapter — annotation-create', () => {
  it('splits target on first colon → target_collection / target_id', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationCreate: async (input) => {
        captured = input;
        return { annotation_id: 'a1', annotation: mkAnnotation() };
      },
    });
    await adapter(
      mkCall('annotation-create', {
        target: 'data.contact:jane@acme.com',
        key: 'company',
        value: 'Acme',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's',
        recipe_hash: 'r',
      }),
    );
    expect(captured).toMatchObject({
      target_collection: 'data.contact',
      target_id: 'jane@acme.com',
      key: 'company',
      value: 'Acme',
    });
  });

  it('folds confidence into value as { value, confidence } when present', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationCreate: async (input) => {
        captured = input;
        return { annotation_id: 'a1', annotation: mkAnnotation() };
      },
    });
    await adapter(
      mkCall('annotation-create', {
        target: 'data.contact:jane@acme.com',
        key: 'role',
        value: 'CTO',
        confidence: 0.91,
        authored_by_recipe_id: 'r1',
        source_record_hash: 's',
        recipe_hash: 'r',
      }),
    );
    expect((captured as { value: unknown }).value).toEqual({ value: 'CTO', confidence: 0.91 });
  });

  it('passes value through unwrapped when confidence absent', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      annotationCreate: async (input) => {
        captured = input;
        return { annotation_id: 'a1', annotation: mkAnnotation() };
      },
    });
    await adapter(
      mkCall('annotation-create', {
        target: 'data.contact:jane@acme.com',
        key: 'role',
        value: 'CTO',
        authored_by_recipe_id: 'r1',
        source_record_hash: 's',
        recipe_hash: 'r',
      }),
    );
    expect((captured as { value: unknown }).value).toBe('CTO');
  });

  it('BAD_INPUT when target malformed', async () => {
    const adapter = createKernelAdapter({
      annotationCreate: async () => ({ annotation_id: 'a1', annotation: mkAnnotation() }),
    });
    await expect(
      adapter(mkCall('annotation-create', {
        target: 'no-colon', key: 'k', value: 'v',
        authored_by_recipe_id: 'r1', source_record_hash: 's', recipe_hash: 'r',
      })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('BAD_INPUT when source_record_hash missing', async () => {
    const adapter = createKernelAdapter({
      annotationCreate: async () => ({ annotation_id: 'a1', annotation: mkAnnotation() }),
    });
    await expect(
      adapter(mkCall('annotation-create', {
        target: 'data.contact:x', key: 'k', value: 'v',
        authored_by_recipe_id: 'r1', recipe_hash: 'r',
      })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('SERVER_NOT_REACHABLE when dispatcher absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall('annotation-create', {
        target: 'data.contact:x', key: 'k', value: 'v',
        authored_by_recipe_id: 'r1', source_record_hash: 's', recipe_hash: 'r',
      })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});

// ────────────────────────────────────────────────────────────────
// timeline-read
// ────────────────────────────────────────────────────────────────

describe('kernel adapter — timeline-read', () => {
  it('passes the combined entity string straight through (no split)', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      timelineRead: async (input) => {
        captured = input;
        return { entries: [] as TimelineEntry[] };
      },
    });
    await adapter(
      mkCall('timeline-read', {
        entity: 'data.contact:jane@acme.com',
        axis: 'event',
        limit: 50,
      }),
    );
    expect(captured).toEqual({
      entity: 'data.contact:jane@acme.com',
      axis: 'event',
      limit: 50,
    });
  });

  it('omits unsupported axis values silently', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      timelineRead: async (input) => {
        captured = input;
        return { entries: [] };
      },
    });
    await adapter(
      mkCall('timeline-read', {
        entity: 'data.mail:m1', axis: 'unknown',
      }),
    );
    expect((captured as { axis?: string }).axis).toBeUndefined();
  });

  it('forwards next_cursor when the dispatcher returns one', async () => {
    const adapter = createKernelAdapter({
      timelineRead: async () => ({
        entries: [],
        next_cursor: 'c-abc',
      }),
    });
    const res = await adapter(
      mkCall('timeline-read', { entity: 'data.mail:m1' }),
    ) as { entries: unknown[]; next_cursor?: string };
    expect(res.next_cursor).toBe('c-abc');
  });

  it('BAD_INPUT when entity missing colon', async () => {
    const adapter = createKernelAdapter({
      timelineRead: async () => ({ entries: [] }),
    });
    await expect(
      adapter(mkCall('timeline-read', { entity: 'no-colon' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('BAD_INPUT when entity missing entirely', async () => {
    const adapter = createKernelAdapter({
      timelineRead: async () => ({ entries: [] }),
    });
    await expect(
      adapter(mkCall('timeline-read', {})),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('SERVER_NOT_REACHABLE when dispatcher absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall('timeline-read', { entity: 'data.mail:m1' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
