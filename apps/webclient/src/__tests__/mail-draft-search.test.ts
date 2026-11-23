import { describe, expect, it, vi } from 'vitest';
import type { MailDraftSummary } from '@recued/contracts';
import { createMailDraftSearch, readMailDraftPage, type MailDraftListCaller } from '../mail/mail-draft-search.js';

const id = (n: number): string => `mad_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number): MailDraftSummary => ({ draft_id: id(n), incarnation: 'test', revision: 1,
  subject: `Quote ${n}`, sender_mail_instance: 'work', to: [`person${n}@example.test`],
  origin_contract_id: null, created_at: 1, updated_at: 1 });
type Page = Awaited<ReturnType<MailDraftListCaller>>;
const deferred = () => { let resolve!: (value: Page) => void; const promise = new Promise<Page>(done => { resolve = done; }); return { promise, resolve }; };

describe('saved draft search paging', () => {
  it('continues empty encrypted scan pages with the same query and sender before declaring a result', async () => {
    const caller = vi.fn<MailDraftListCaller>().mockResolvedValueOnce({ drafts: [], next_cursor: id(100) })
      .mockResolvedValueOnce({ drafts: [row(101)], next_cursor: null });
    const result = await readMailDraftPage(caller, { query: 'quote', sender_mail_instance: 'work', limit: 25 }, () => true);
    expect(result?.drafts).toEqual([row(101)]);
    expect(caller.mock.calls.map(([request]) => request)).toEqual([
      { query: 'quote', sender_mail_instance: 'work', limit: 25 },
      { query: 'quote', sender_mail_instance: 'work', limit: 25, cursor: id(100) },
    ]);
  });
  it('retires a scan at an input change and ignores late replies, including an edit away and back', async () => {
    const late = deferred(), caller = vi.fn<MailDraftListCaller>()
      .mockReturnValueOnce(late.promise).mockResolvedValue({ drafts: [row(2)], next_cursor: null });
    const search = createMailDraftSearch(caller, () => {});
    const first = search.load('quote'); search.reset(); await search.load('quote');
    late.resolve({ drafts: [], next_cursor: id(100) }); await first;
    expect(search.state().matches).toEqual([row(2)]);
    expect(caller).toHaveBeenCalledTimes(2);
  });
  it('keeps confirmed matches and retries a failed More from its original cursor', async () => {
    const caller = vi.fn<MailDraftListCaller>().mockResolvedValueOnce({ drafts: [1, 2, 3, 4, 5].map(row), next_cursor: id(5) })
      .mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ drafts: [row(6)], next_cursor: null });
    const search = createMailDraftSearch(caller, () => {});
    await search.load('quote'); await search.load('quote', true);
    expect(search.state()).toMatchObject({ matches: [1, 2, 3, 4, 5].map(row), next_cursor: id(5), error: 'Offline', retry_append: true });
    await search.load('quote', true);
    expect(search.state().matches).toEqual([1, 2, 3, 4, 5, 6].map(row));
    expect(caller.mock.calls[2]).toEqual(caller.mock.calls[1]);
  });
  it('rejects a nonadvancing empty scan and distinguishes an unsupported server from no matches', async () => {
    const repeated = vi.fn<MailDraftListCaller>().mockResolvedValue({ drafts: [], next_cursor: id(1) });
    await expect(readMailDraftPage(repeated, { query: 'quote' }, () => true)).rejects.toThrow('did not advance');
    const search = createMailDraftSearch(async () => { throw { code: 'unknown_method', message: 'Unknown method' }; }, () => {});
    await search.load('quote');
    expect(search.state()).toMatchObject({ loading: false, unsupported: true, matches: [] });
  });
});
