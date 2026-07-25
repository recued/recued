/** D-172 step 5b — reception drop-link resumable uploader (the HTTP consumer).
 *
 *  Three layers, matching the source split:
 *   1. `http-transport.ts` — the fetch-per-chunk DATA plane: maps the reception
 *      chunk HTTP response onto an `UploadChunkOutcome`; a network failure is a
 *      transient `UploadTransportFault`.
 *   2. `reception-drop-uploader.ts` `createReceptionUploadCallers` — the CONTROL
 *      plane over `fetch` (create / probe / finalize / delete): form_nonce on
 *      create, visitor PII on finalize, reception reject codes → throw.
 *   3. `mountReceptionDropUploader` — the DOM glue: progressive-enhance the
 *      server-rendered drop `<form>` (intercept submit → drive the engine), over
 *      a compact fake DOM + fake fetch (no jsdom in this repo).
 *
 *  The shared engine + WS path are proven in `d-172-upload.test.ts`; the real
 *  reception server is proven in
 *  `backend/server/src/__tests__/d-172-p5a-reception-upload-http.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { createHttpUploadTransport } from '../upload/http-transport.js';
import {
  createReceptionUploadCallers,
  mountReceptionDropUploader,
} from '../upload/reception-drop-uploader.js';
import { UploadTransportFault } from '../upload/types.js';
import type { UploadFetch, UploadFetchInit } from '../upload/types.js';

// ════════════════════════════════════════════════════════════════════
// Fake fetch
// ════════════════════════════════════════════════════════════════════

interface FetchCall {
  url: string;
  method: string;
  init?: UploadFetchInit;
}
interface FakeReply {
  status: number;
  ok?: boolean;
  body?: unknown;
  /** Make `json()` reject (a malformed / empty body). */
  jsonThrows?: boolean;
  /** Make the fetch itself reject (a network failure). */
  networkError?: boolean;
}

const makeFetch = (
  reply: (call: FetchCall) => FakeReply,
): { fn: UploadFetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fn: UploadFetch = async (url, init) => {
    const call: FetchCall = { url, method: init?.method ?? 'GET', ...(init ? { init } : {}) };
    calls.push(call);
    const r = reply(call);
    if (r.networkError === true) throw new Error('network down');
    return {
      ok: r.ok ?? (r.status >= 200 && r.status < 300),
      status: r.status,
      json: async () => {
        if (r.jsonThrows === true) throw new Error('not json');
        return r.body ?? null;
      },
    };
  };
  return { fn, calls };
};

const bytesOf = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_u, i) => i % 251);

// ════════════════════════════════════════════════════════════════════
// 1. HttpUploadTransport
// ════════════════════════════════════════════════════════════════════

describe('HttpUploadTransport — chunk send', () => {
  const chunkUrl = (id: string): string => `/reception/drop/ep1/uploads/${id}?t=secret`;

  it('200 → ok outcome; sends offset + checksum headers + raw bytes to the chunk URL', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 200, body: { offset: 10, complete: false } }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    const bytes = bytesOf(10);
    const outcome = await t.send({ uploadId: 'up-9', offset: 4, checksum: 'abc123', bytes });
    expect(outcome).toEqual({ ok: true, offset: 10, complete: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/reception/drop/ep1/uploads/up-9?t=secret');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.init?.headers?.['upload-offset']).toBe('4');
    expect(calls[0]!.init?.headers?.['upload-checksum']).toBe('abc123');
    expect(calls[0]!.init?.body).toBe(bytes);
  });

  it('200 complete → ok+complete', async () => {
    const { fn } = makeFetch(() => ({ status: 200, body: { offset: 6, complete: true } }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    expect(await t.send({ uploadId: 'u', offset: 0, checksum: 'c', bytes: bytesOf(6) })).toEqual({
      ok: true,
      offset: 6,
      complete: true,
    });
  });

  it('409 offset_conflict carries the real offset (→ engine re-syncs)', async () => {
    const { fn } = makeFetch(() => ({
      status: 409,
      body: { error: { code: 'offset_conflict' }, offset: 8 },
    }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    expect(await t.send({ uploadId: 'u', offset: 4, checksum: 'c', bytes: bytesOf(4) })).toEqual({
      ok: false,
      reason: 'offset_conflict',
      offset: 8,
    });
  });

  it('422 checksum_mismatch → recoverable !ok (engine re-sends)', async () => {
    const { fn } = makeFetch(() => ({ status: 422, body: { error: { code: 'checksum_mismatch' } } }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    expect(await t.send({ uploadId: 'u', offset: 0, checksum: 'c', bytes: bytesOf(4) })).toEqual({
      ok: false,
      reason: 'checksum_mismatch',
    });
  });

  it.each([
    [404, 'not_found'],
    [410, 'expired'],
    [413, 'chunk_too_large'],
    [400, 'chunk_too_small'],
  ])('%i → terminal !ok outcome carrying the reason code', async (status, code) => {
    const { fn } = makeFetch(() => ({ status, body: { error: { code } } }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    expect(await t.send({ uploadId: 'u', offset: 0, checksum: 'c', bytes: bytesOf(4) })).toEqual({
      ok: false,
      reason: code,
    });
  });

  it('a 2xx with an unparseable body is a transport FAULT (not a silent ok)', async () => {
    const { fn } = makeFetch(() => ({ status: 200, jsonThrows: true }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    await expect(t.send({ uploadId: 'u', offset: 0, checksum: 'c', bytes: bytesOf(4) })).rejects.toBeInstanceOf(
      UploadTransportFault,
    );
  });

  it('a network failure rejects with UploadTransportFault (→ engine reconnect+reprobe)', async () => {
    const { fn } = makeFetch(() => ({ status: 0, networkError: true }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    await expect(t.send({ uploadId: 'u', offset: 0, checksum: 'c', bytes: bytesOf(4) })).rejects.toBeInstanceOf(
      UploadTransportFault,
    );
  });

  it('open() + reset() are no-ops (connectionless)', async () => {
    const { fn } = makeFetch(() => ({ status: 200, body: { offset: 1, complete: true } }));
    const t = createHttpUploadTransport({ chunkUrl, fetchImpl: fn });
    await expect(t.open(() => false)).resolves.toBeUndefined();
    expect(() => t.reset()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. createReceptionUploadCallers
// ════════════════════════════════════════════════════════════════════

const callersOpts = (
  fn: UploadFetch,
  over: Partial<{ getFormNonce: () => string; getVisitorFields: () => Record<string, string> }> = {},
) => ({
  uploadsBase: '/reception/drop/ep1/uploads',
  token: 'sec ret', // a space proves URL-encoding of the bearer
  getFormNonce: over.getFormNonce ?? (() => 'nonce-XYZ'),
  getVisitorFields: over.getVisitorFields ?? (() => ({})),
  fetchImpl: fn,
});

const parseBody = (call: FetchCall): Record<string, unknown> =>
  JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;

describe('reception callers — create', () => {
  it('201 → created; injects form_nonce + url-encodes the bearer', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 201, body: { upload_id: 'up-1', offset: 0 } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    const r = await callers.create({ filename: 'a.bin', declared_size: 9, mime_reported: 'image/png' });
    expect(r).toEqual({ status: 'created', upload_id: 'up-1' });
    expect(calls[0]!.url).toBe('/reception/drop/ep1/uploads?t=sec%20ret');
    expect(calls[0]!.method).toBe('POST');
    expect(parseBody(calls[0]!)).toEqual({
      filename: 'a.bin',
      declared_size: 9,
      mime_reported: 'image/png',
      form_nonce: 'nonce-XYZ',
    });
  });

  it.each([
    [400, 'invalid_nonce'],
    [413, 'size_cap_exceeded'],
    [429, 'too_many_sessions'],
    [503, 'not_configured'],
  ])('%i reject → throws the reception code (terminal in the engine)', async (status, code) => {
    const { fn } = makeFetch(() => ({ status, body: { error: { code } } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    await expect(
      callers.create({ filename: 'a', declared_size: 1, mime_reported: 'x' }),
    ).rejects.toThrow(code);
  });

  it('201 with a missing upload_id throws', async () => {
    const { fn } = makeFetch(() => ({ status: 201, body: {} }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    await expect(
      callers.create({ filename: 'a', declared_size: 1, mime_reported: 'x' }),
    ).rejects.toThrow('bad_create_response');
  });
});

describe('reception callers — probe', () => {
  it('200 → resumable; sends filename + declared_size + bearer in the query', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 200, body: { offset: 8, complete: false } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    const r = await callers.probe({ upload_id: 'up-1', filename: 'a b.bin', declared_size: 20 });
    expect(r).toEqual({ resumable: true, offset: 8, complete: false });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/reception/drop/ep1/uploads/up-1?t=sec%20ret');
    expect(calls[0]!.url).toContain('filename=a%20b.bin');
    expect(calls[0]!.url).toContain('declared_size=20');
  });

  it.each([
    [404, 'not_found'],
    [410, 'expired'],
    [409, 'file_mismatch'],
  ])('%i → not-resumable %s', async (status, reason) => {
    const { fn } = makeFetch(() => ({ status, body: { error: { code: reason } } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    expect(await callers.probe({ upload_id: 'u', filename: 'a', declared_size: 1 })).toEqual({
      resumable: false,
      reason,
    });
  });
});

describe('reception callers — finalize', () => {
  it('200 accepted → finalized (blob_id → record_id); rides the visitor PII snapshot', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 200, body: { status: 'accepted', blob_id: 'b-7' } }));
    const callers = createReceptionUploadCallers(
      callersOpts(fn, {
        getVisitorFields: () => ({ visitor_name: 'Ada', visitor_email: 'ada@x.io' }),
      }),
    );
    const r = await callers.finalize({ upload_id: 'up-1' });
    expect(r).toEqual({ status: 'finalized', record_id: 'b-7', content_hash: '', size_bytes: 0 });
    expect(calls[0]!.url).toBe('/reception/drop/ep1/uploads/up-1/finalize?t=sec%20ret');
    expect(parseBody(calls[0]!)).toEqual({ visitor_name: 'Ada', visitor_email: 'ada@x.io' });
  });

  it('409 incomplete → pending(offset) so the engine resumes', async () => {
    const { fn } = makeFetch(() => ({ status: 409, body: { error: { code: 'incomplete' }, offset: 12 } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    expect(await callers.finalize({ upload_id: 'u' })).toEqual({
      status: 'pending',
      reason: 'incomplete',
      offset: 12,
    });
  });

  it.each([
    [410, 'expired'],
    [404, 'not_found'],
  ])('%i → gone(%s)', async (status, reason) => {
    const { fn } = makeFetch(() => ({ status, body: { error: { code: reason } } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    expect(await callers.finalize({ upload_id: 'u' })).toEqual({ status: 'gone', reason });
  });

  it.each([
    [415, 'rejected_mime'],
    [413, 'rejected_size'],
    [422, 'failed'],
  ])('%i content rejection → throws the reception code', async (status, code) => {
    const { fn } = makeFetch(() => ({ status, body: { error: { code } } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    await expect(callers.finalize({ upload_id: 'u' })).rejects.toThrow(code);
  });
});

describe('reception callers — delete', () => {
  it('maps { deleted } (best-effort cancel)', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 200, body: { deleted: true } }));
    const callers = createReceptionUploadCallers(callersOpts(fn));
    expect(await callers.delete({ upload_id: 'up-1' })).toEqual({ deleted: true });
    expect(calls[0]!.method).toBe('DELETE');
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. mountReceptionDropUploader — DOM glue over a compact fake DOM
// ════════════════════════════════════════════════════════════════════

const waitFor = async (pred: () => boolean, label = 'condition'): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${label}`);
};

interface FakeEl {
  tag: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | FakeDoc | null;
  listeners: Map<string, Array<(e: unknown) => void>>;
  style: Record<string, string>;
  className: string;
  textContent: string;
  value?: string;
  files?: unknown;
  disabled?: boolean;
  ownerDocument: FakeDoc;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  appendChild(c: FakeEl): FakeEl;
  insertAdjacentElement(pos: string, el: FakeEl): FakeEl;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  querySelector(sel: string): FakeEl | null;
  dispatch(t: string, e: unknown): void;
  readonly elements: FakeEl[];
}
interface FakeDoc {
  children: FakeEl[];
  createElement(tag: string): FakeEl;
  querySelector(sel: string): FakeEl | null;
}

const parseSel = (sel: string): { tag?: string; cls?: string; attrs: Array<[string, string?]> } => {
  let rest = sel;
  let tag: string | undefined;
  let cls: string | undefined;
  const tagM = /^([a-zA-Z0-9]+)/.exec(rest);
  if (tagM) {
    tag = tagM[1];
    rest = rest.slice(tagM[1]!.length);
  }
  const clsM = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
  if (clsM) {
    cls = clsM[1];
    rest = rest.slice(clsM[0].length);
  }
  const attrs: Array<[string, string?]> = [];
  for (const am of rest.matchAll(/\[([a-zA-Z_-]+)(?:="([^"]*)")?\]/g)) {
    attrs.push([am[1]!, am[2]]);
  }
  return { tag: tag ?? undefined, cls: cls ?? undefined, attrs };
};

const elMatches = (el: FakeEl, sel: string): boolean => {
  const p = parseSel(sel);
  if (p.tag !== undefined && el.tag !== p.tag) return false;
  if (p.cls !== undefined && !(el.getAttribute('class') ?? '').split(/\s+/).includes(p.cls)) {
    return false;
  }
  for (const [a, v] of p.attrs) {
    const have = el.getAttribute(a);
    if (v === undefined) {
      if (have === null) return false;
    } else if (have !== v) return false;
  }
  return true;
};

const queryIn = (root: FakeEl | FakeDoc, sel: string): FakeEl | null => {
  for (const c of root.children) {
    if (elMatches(c, sel)) return c;
    const nested = queryIn(c, sel);
    if (nested !== null) return nested;
  }
  return null;
};

const makeDoc = (): FakeDoc => {
  const doc: FakeDoc = {
    children: [],
    createElement: (tag) => makeEl(tag, doc),
    querySelector: (sel) => queryIn(doc, sel),
  };
  return doc;
};

const makeEl = (tag: string, doc: FakeDoc, attrs: Record<string, string> = {}): FakeEl => {
  const el: FakeEl = {
    tag,
    attrs: new Map(Object.entries(attrs)),
    children: [],
    parent: null,
    listeners: new Map(),
    style: {},
    className: '',
    textContent: '',
    ownerDocument: doc,
    getAttribute: (n) => (n === 'class' && el.className ? el.className : el.attrs.get(n) ?? null),
    setAttribute: (n, v) => {
      el.attrs.set(n, v);
    },
    appendChild: (c) => {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    insertAdjacentElement: (pos, other) => {
      if (pos === 'afterend' && el.parent !== null) {
        const siblings = el.parent.children;
        siblings.splice(siblings.indexOf(el) + 1, 0, other);
        other.parent = el.parent;
      }
      return other;
    },
    addEventListener: (t, fn) => {
      const l = el.listeners.get(t) ?? [];
      l.push(fn);
      el.listeners.set(t, l);
    },
    removeEventListener: (t, fn) => {
      const l = el.listeners.get(t);
      if (l !== undefined) el.listeners.set(t, l.filter((f) => f !== fn));
    },
    querySelector: (sel) => queryIn(el, sel),
    dispatch: (t, e) => {
      for (const fn of el.listeners.get(t) ?? []) fn(e);
    },
    get elements() {
      const out: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const c of n.children) {
          if (c.tag === 'input' || c.tag === 'textarea' || c.tag === 'button') out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
  };
  if (attrs.class !== undefined) el.className = attrs.class;
  return el;
};

const fakeFile = (bytes: Uint8Array, name = 'photo.bin') => ({
  name,
  size: bytes.length,
  type: 'image/png',
  lastModified: 11,
  slice: (s: number, e: number) => ({ arrayBuffer: async () => bytes.slice(s, e).buffer }),
});

/** Build the drop form the server renders (the subset the bootstrap reads). */
const buildDropDom = (): { doc: FakeDoc; form: FakeEl; fileInput: FakeEl } => {
  const doc = makeDoc();
  const card = makeEl('div', doc, { class: 'rcp-card' });
  doc.children.push(card);
  const form = makeEl('form', doc, {
    class: 'rcp-form',
    action: '/reception/drop/ep1?t=sec%20ret',
  });
  card.appendChild(form);
  const nonce = makeEl('input', doc, { name: 'form_nonce' });
  nonce.value = 'nonce-XYZ';
  form.appendChild(nonce);
  const vname = makeEl('input', doc, { name: 'visitor_name' });
  vname.value = 'Ada';
  form.appendChild(vname);
  const fileInput = makeEl('input', doc, { type: 'file', name: 'blob' });
  form.appendChild(fileInput);
  const submit = makeEl('button', doc, { type: 'submit' });
  form.appendChild(submit);
  return { doc, form, fileInput };
};

describe('mountReceptionDropUploader — DOM bootstrap', () => {
  it('returns null when there is no drop form (degrade to the JS-free form)', () => {
    const doc = makeDoc();
    const handle = mountReceptionDropUploader({ root: doc as unknown as ParentNode });
    expect(handle).toBeNull();
  });

  it('intercepts submit → drives create/chunk/finalize over the reception protocol to done', async () => {
    const { doc, form, fileInput } = buildDropDom();
    const bytes = bytesOf(6); // one chunk (< the 4 MiB default)
    fileInput.files = [fakeFile(bytes)];

    const { fn, calls } = makeFetch((call) => {
      const path = call.url.split('?')[0]!;
      if (path === '/reception/drop/ep1/uploads' && call.method === 'POST') {
        return { status: 201, body: { upload_id: 'up-1', offset: 0 } };
      }
      if (path.endsWith('/finalize') && call.method === 'POST') {
        return { status: 200, body: { status: 'accepted', blob_id: 'blob-9' } };
      }
      if (path === '/reception/drop/ep1/uploads/up-1' && call.method === 'POST') {
        // single chunk → complete
        return { status: 200, body: { offset: 6, complete: true } };
      }
      return { status: 404, body: { error: { code: 'not_found' } } };
    });

    let prevented = false;
    const handle = mountReceptionDropUploader({
      root: doc as unknown as ParentNode,
      fetchImpl: fn,
    });
    expect(handle).not.toBeNull();

    form.dispatch('submit', { preventDefault: () => { prevented = true; } });
    await waitFor(
      () => calls.some((c) => c.url.includes('/finalize')),
      'finalize',
    );
    // small drain so the engine's done emit + progress paint settle
    await new Promise((r) => setTimeout(r, 0));

    // The resumable path took over (the plain form POST was suppressed).
    expect(prevented).toBe(true);

    // create → chunk → finalize, over the reception URL space + bearer.
    const create = calls.find((c) => c.url.split('?')[0] === '/reception/drop/ep1/uploads')!;
    expect(JSON.parse(String(create.init?.body))).toMatchObject({
      filename: 'photo.bin',
      declared_size: 6,
      form_nonce: 'nonce-XYZ',
    });
    const chunk = calls.find((c) => c.url.split('?')[0] === '/reception/drop/ep1/uploads/up-1')!;
    expect(chunk.init?.headers?.['upload-offset']).toBe('0');
    // The engine slices the File into a fresh Uint8Array — compare contents.
    expect(chunk.init?.body).toStrictEqual(bytes);
    const finalize = calls.find((c) => c.url.includes('/finalize'))!;
    // The visitor PII snapshot rides finalize.
    expect(JSON.parse(String(finalize.init?.body))).toEqual({ visitor_name: 'Ada' });

    // The form was disabled + a progress region inserted; on done it reports success.
    expect(form.getAttribute('data-uploading')).toBe('');
    expect(fileInput.disabled).toBe(true);
    const progress = queryIn(doc, '.rcp-upload-progress');
    expect(progress).not.toBeNull();
    await waitFor(() => (progress!.querySelector('.rcp-upload-status')?.textContent ?? '').includes('received'), 'done');

    handle!.destroy();
  });
});
