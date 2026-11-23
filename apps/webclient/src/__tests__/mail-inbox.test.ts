import { describe, expect, it } from 'vitest';
import type { CollectionListQuery, CollectionRecord } from '@recued/contracts';
import { createMailInbox, defaultMailInboxFilters, MAIL_INBOX_PAGE_SIZE, mailInboxMemory } from '../data/mail-inbox.js';

const row = (n: number): CollectionRecord => ({
  record_id: `mail-${String(n).padStart(3, '0')}`, received_at: 1_700_000_000_000 + Math.floor(n / 4),
  modified_at: 1_700_000_000_000, source_id: String(n), size_bytes: 10,
  hot_fields: { subject: `Message ${n}`, direction: n % 5 === 0 ? 'outbound' : 'inbound',
    is_read: n % 3 === 0, is_flagged: n % 7 === 0, has_attachments: n % 4 === 0 },
});
const fixture = (count = 80) => {
  const rows = Array.from({ length: count }, (_, index) => row(count - index));
  const requests: CollectionListQuery[] = [];
  let fail = false;
  const list = async (query: CollectionListQuery) => {
    requests.push(structuredClone(query));
    if (fail) { fail = false; throw new Error('Mail is temporarily unavailable.'); }
    return { records: rows.filter(row => Object.entries(query.filters ?? {}).every(([key, value]) => row.hot_fields[key] === value))
      .filter(row => !query.before || row.received_at < query.before.received_at
        || row.received_at === query.before.received_at && row.record_id < query.before.record_id)
      .slice(0, query.limit) };
  };
  return { rows, requests, list, failNext: () => { fail = true; } };
};
const delayed = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('mailbox filters and page continuity', () => {
  it('applies status, direction and attachment filters at the server before requesting a page', async () => {
    const { requests, list } = fixture(); const inbox = createMailInbox(list, () => {});
    await inbox.select('work');
    await inbox.filter({ status: 'unread', direction: 'received', attachments: true });
    expect(requests.at(-1)).toEqual({ platform: 'mail', slug: 'work',
      filters: { is_read: false, direction: 'inbound', has_attachments: true }, limit: MAIL_INBOX_PAGE_SIZE + 1 });
    expect(inbox.snapshot()!.records.map(row => row.record_id)).toEqual(['mail-076', 'mail-068', 'mail-064', 'mail-056', 'mail-052', 'mail-044', 'mail-032', 'mail-028', 'mail-016', 'mail-008', 'mail-004']);
    await inbox.filter({ status: 'starred', direction: 'sent', attachments: false });
    expect(inbox.snapshot()!.records.map(row => row.record_id)).toEqual(['mail-070', 'mail-035']);
  });

  it('walks timestamp ties without gaps and uses a lookahead row to confirm the end', async () => {
    const { list, requests, rows } = fixture(65); const inbox = createMailInbox(list, () => {});
    await inbox.select('work'); expect(inbox.snapshot()!.records).toHaveLength(30);
    const last = inbox.snapshot()!.records.at(-1)!;
    await inbox.more();
    expect(requests[1]!.before).toEqual({ received_at: last.received_at, record_id: last.record_id });
    await inbox.more(); expect(inbox.snapshot()!.records).toEqual(rows); expect(inbox.snapshot()!.hasMore).toBe(false);
    await inbox.more(); expect(requests).toHaveLength(3);
  });

  it('retries the failed next page without losing the previous page or its cursor', async () => {
    const { list, requests, failNext } = fixture(); const inbox = createMailInbox(list, () => {});
    await inbox.select('work'); const before = [...inbox.snapshot()!.records];
    failNext(); await inbox.more();
    expect(inbox.snapshot()!.records).toEqual(before); expect(inbox.snapshot()!.error).toContain('unavailable');
    await inbox.retry(); expect(requests[2]).toEqual(requests[1]); expect(inbox.snapshot()!.records).toHaveLength(60);
    expect(inbox.snapshot()!.error).toBeUndefined();
  });

  it('retires older filter and mailbox responses and prevents duplicate next-page requests', async () => {
    const { list } = fixture(); const pending = delayed<{ records: CollectionRecord[] }>();
    let hold = false, heldCalls = 0;
    const inbox = createMailInbox(query => { if (hold) { heldCalls++; return pending.promise; } return list(query); }, () => {});
    await inbox.select('work'); hold = true;
    const older = inbox.more(); void inbox.more(); expect(heldCalls).toBe(1);
    hold = false; await inbox.filter({ status: 'starred', direction: 'all', attachments: false });
    await inbox.select('other');
    pending.resolve({ records: [row(1)] }); await older;
    expect(inbox.snapshot()!.slug).toBe('other'); expect(inbox.snapshot()!.filters.status).toBe('all');
    expect(inbox.snapshot()!.records[0]!.record_id).toBe('mail-080');
    await inbox.select('work'); expect(inbox.snapshot()!.filters.status).toBe('starred');
  });

  it('clears the old result scope on a failed filter change and retries those exact filters', async () => {
    const { list, requests, failNext } = fixture(); const inbox = createMailInbox(list, () => {});
    await inbox.select('work'); failNext(); await inbox.filter({ status: 'starred', direction: 'all', attachments: false });
    expect(inbox.snapshot()!.records).toEqual([]); expect(inbox.snapshot()!.pages).toBe(0);
    expect(inbox.snapshot()!.filters.status).toBe('starred');
    await inbox.retry(); expect(requests.at(-1)).toEqual(requests.at(-2)); expect(inbox.snapshot()!.records.length).toBeGreaterThan(0);
  });

  it('rejects ignored filters or a repeated page from an older server instead of showing misleading results', async () => {
    const { list, rows } = fixture(); let ignore = false;
    const inbox = createMailInbox(query => ignore ? Promise.resolve({ records: rows.slice(0, 31) }) : list(query), () => {});
    await inbox.select('work'); const before = [...inbox.snapshot()!.records]; ignore = true;
    await inbox.more(); expect(inbox.snapshot()!.records).toEqual(before); expect(inbox.snapshot()!.error).toContain('advance');
    await inbox.filter({ status: 'starred', direction: 'all', attachments: false });
    expect(inbox.snapshot()!.records).toEqual([]); expect(inbox.snapshot()!.error).toContain('filters');
  });

  it('preserves filter and page hints across route mounts within one server, without caching bodies across servers', async () => {
    const { list } = fixture(); const owner = {}, memory = mailInboxMemory(owner);
    const inbox = createMailInbox(list, () => {}, memory); await inbox.select('work'); await inbox.more();
    const position = { recordId: 'mail-025', nearby: ['mail-024'], scrollTop: 700, hash: '#data/mail' };
    inbox.rememberPosition(position); inbox.dispose();
    const remounted = createMailInbox(list, () => {}, mailInboxMemory(owner));
    expect(remounted.snapshot()).toBeNull(); expect(remounted.selectedSlug()).toBe('work');
    await remounted.select('work'); expect(remounted.snapshot()!.records).toHaveLength(60); expect(remounted.position()).toEqual(position);
    const other = createMailInbox(list, () => {}, mailInboxMemory({})); expect(other.selectedSlug()).toBeUndefined();
    await other.select('work'); expect(other.snapshot()!.records).toHaveLength(30);
    await remounted.filter({ status: 'unread', direction: 'all', attachments: false });
    await remounted.select('other'); expect(remounted.snapshot()!.filters).toEqual(defaultMailInboxFilters());
    await remounted.select('work'); expect(remounted.snapshot()!.filters.status).toBe('unread');
  });

  it('removes a message that no longer matches after verified mail triage and refills loaded pages on refresh', async () => {
    const { list, rows } = fixture(); const inbox = createMailInbox(list, () => {});
    await inbox.select('work'); await inbox.filter({ status: 'unread', direction: 'all', attachments: false }); await inbox.more();
    const first = inbox.snapshot()!.records[0]!, changed = { ...first, hot_fields: { ...first.hot_fields, is_read: true } };
    rows.splice(rows.findIndex(row => row.record_id === changed.record_id), 1, changed);
    inbox.reconcile(changed); expect(inbox.snapshot()!.records.some(row => row.record_id === changed.record_id)).toBe(false);
    await inbox.refresh(); expect(inbox.snapshot()!.pages).toBe(2);
    expect(inbox.snapshot()!.records.some(row => row.record_id === changed.record_id)).toBe(false);
  });
});
