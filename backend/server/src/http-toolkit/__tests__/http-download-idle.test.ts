/** 2026-11-23 (the owner: "Same idle limit for the HTTP Toolkit's own download") — the HTTP Toolkit's download gives a
 *  site that stalls 20 s with nothing new, within its two minutes in all, as a step that saves a file does when the
 *  server fetches it first (task L). `public-fetch.test.ts` shows the limit itself working on a real socket; this file
 *  shows the download asking for it and saying the stall, without waiting 20 s for one. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as Array<{ address: string; options: Record<string, unknown> }>);
const answer = vi.hoisted(() => ({ next: undefined as undefined | (() => unknown) }));

vi.mock('../public-fetch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../public-fetch.js')>();
  return {
    ...real,
    publicFetch: vi.fn(async (address: string, options: Record<string, unknown>) => {
      calls.push({ address, options });
      return answer.next!();
    }),
  };
});

const { DOWNLOAD_IDLE_MS, SERVER_FIRST_IDLE_MS, HttpActionError, createPublicFileFetch, httpDownload } = await import('../http-actions.js');
const { PublicFetchError } = await import('../public-fetch.js');

const files = { keep: vi.fn(async () => ({ file_id: 'f1', filename: 'report.pdf', size_bytes: 3 })) } as never;

beforeEach(() => {
  calls.length = 0;
  answer.next = undefined;
});

describe('the HTTP Toolkit\'s download lets a stalled site go after 20 s with nothing new', () => {
  it('asks the fetch for the idle limit, within its two minutes in all', async () => {
    answer.next = () => ({ url: 'https://files.example/report.pdf', status: 200, status_text: 'OK',
      headers: { 'content-type': 'application/pdf' }, body: Buffer.from('pdf'), redirects: [], truncated: false });
    await httpDownload({ files }, { address: 'https://files.example/report.pdf' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 120_000, idleTimeoutMs: 20_000 });
    expect(DOWNLOAD_IDLE_MS).toBe(20_000);
  });

  it('a stall is refused as one, in the fetch\'s own words, and nothing is kept', async () => {
    answer.next = () => { throw new PublicFetchError('timeout', 'files.example sent nothing for 20 seconds.', { host: 'files.example' }); };
    const kept = vi.fn();
    const out = httpDownload({ files: { keep: kept } as never }, { address: 'https://files.example/big.zip' });
    await expect(out).rejects.toBeInstanceOf(HttpActionError);
    await expect(out).rejects.toMatchObject({ code: 'FETCH_FAILED', message: 'files.example sent nothing for 20 seconds.' });
    expect(kept).not.toHaveBeenCalled();
  });

  it('a step\'s own fetch before the Bridge asks for the same idle limit', async () => {
    answer.next = () => ({ url: 'https://files.example/report.pdf', status: 200, status_text: 'OK',
      headers: { 'content-type': 'application/pdf' }, body: Buffer.from('pdf'), redirects: [], truncated: false });
    await createPublicFileFetch()('https://files.example/report.pdf');
    expect(calls[0]!.options).toMatchObject({ idleTimeoutMs: DOWNLOAD_IDLE_MS });
    expect(SERVER_FIRST_IDLE_MS).toBe(DOWNLOAD_IDLE_MS);
  });
});
