/** D-240 slice 3 — the submitter's viewback route.
 *
 *  The first surface in the reception substrate that answers a NON-OWNER's
 *  question about a record they created. Everything here is about what a
 *  stranger holding a bearer URL is and is not told. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  createReceptionLookupHandler,
  parseLookupSecretFromPath,
  projectLookupState,
  type ReceptionLookupHandlerDeps,
} from '../ports/reception/handlers/lookup.js';
import { RECEPTION_LOOKUP_PATH } from '../ports/reception/handlers/visitor-lookup-mint.js';
import type { FormSubmissionSummary } from '../storage/reception-form-store.js';
import type {
  ReceptionManageCredentialStore,
  ReceptionManageResolveResult,
} from '../storage/reception-manage-credential-store.js';

const NOW = 1_700_000_000_000;
const SECRET = `recued_manage_${'a'.repeat(43)}`;

const record = (over: Partial<FormSubmissionSummary> = {}): FormSubmissionSummary =>
  ({
    submission_id: 'sub-1',
    endpoint_id: 'ep-1',
    form_definition_id: 'fd-1',
    submitted_at: NOW - 60_000,
    source_ip_hash: null,
    visitor_email_encrypted: 'ENCRYPTED-EMAIL',
    submission_blob_encrypted: 'ENCRYPTED-BLOB-WITH-THEIR-ANSWERS',
    schema_version: 1,
    resolved_target_kind: null,
    resolved_target_id: null,
    record_kind: 'intake',
    slot: null,
    processing_outcome: 'pending',
    ...over,
  }) as unknown as FormSubmissionSummary;

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const drive = async (opts: {
  readonly peek?: ReceptionManageResolveResult;
  readonly found?: FormSubmissionSummary | null;
  readonly method?: string;
  readonly run?: ReceptionLookupHandlerDeps['runLookupRecipe'];
}): Promise<Captured & { peekArgs: unknown[] }> => {
  const peekArgs: unknown[] = [];
  const captured: Captured = { status: 0, headers: {}, body: '' };
  const store = {
    peek: (...a: unknown[]) => {
      peekArgs.push(a);
      return opts.peek ?? { status: 'ok', credential_id: 'c1', scope: {
        kind: 'intake_form', endpoint_id: 'ep-1', record_id: 'sub-1', purpose: 'lookup',
      } };
    },
    consume: () => { throw new Error('the viewback must never consume'); },
  } as unknown as ReceptionManageCredentialStore;

  const handler = createReceptionLookupHandler({
    getCredentialStore: () => store,
    findRecord: () => (opts.found === undefined ? record() : opts.found),
    now: () => NOW,
    ...(opts.run === undefined ? {} : { runLookupRecipe: opts.run }),
  });

  const res = {
    statusCode: 0,
    setHeader: () => {},
    writeHead: (status: number, headers: Record<string, string>) => {
      captured.status = status;
      captured.headers = headers;
      (res as { statusCode: number }).statusCode = status;
    },
    end: (body: string) => { captured.body = body; },
  } as unknown as ServerResponse;

  // ⚠ AWAITED. The handler is async since the viewback recipe landed; without
  // this every assertion would read an unwritten response.
  await handler({ method: opts.method ?? 'GET' } as IncomingMessage, res, SECRET);
  return { ...captured, peekArgs };
};

describe('D-240 § D5 — the viewback is a READ, and refreshable', () => {
  it('resolves through `peek` with the LOOKUP purpose, never `consume`', async () => {
    // ⛔ The store's `consume` throws in this fixture: a viewback the visitor
    // could only open once would be burned by the confirmation click itself.
    const out = await drive({});
    expect(out.status).toBe(200);
    expect(out.peekArgs[0]).toEqual([SECRET, NOW, 'lookup']);
  });

  it('⛔ refuses a POST — there is nothing to submit here', async () => {
    expect((await drive({ method: 'POST' })).status).toBe(405);
  });

  it('sets no-store + no-referrer, because the credential is in the PATH', async () => {
    const out = await drive({});
    expect(out.headers['referrer-policy']).toBe('no-referrer');
    expect(out.headers['cache-control']).toBe('no-store');
  });
});

describe('D-240 § D14 — one body for every unresolvable credential', () => {
  it('⛔⛔ expired / consumed / not_found are INDISTINGUISHABLE to the visitor', async () => {
    // Separate copy per status would be an oracle: it confirms which random
    // strings were ever real credentials.
    const bodies = await Promise.all(
      (['expired', 'already_consumed', 'not_found'] as const).map(
        (status) => drive({ peek: { status } }),
      ),
    );
    for (const b of bodies) {
      expect(b.status).toBe(404);
      expect(b.body).toBe(bodies[0]!.body);
    }
  });

  it('a live credential whose record is gone reads the same', async () => {
    const gone = await drive({ found: null });
    expect(gone.status).toBe(404);
    expect(gone.body).toBe((await drive({ peek: { status: 'expired' } })).body);
  });

  it('⛔ a record under a DIFFERENT endpoint than the credential is refused', async () => {
    // The scope was fixed at mint, so it is the authority — not any claim the
    // record row makes about itself.
    expect((await drive({ found: record({ endpoint_id: 'ep-OTHER' }) })).status).toBe(404);
  });
});

describe('D-240 § D13 — what the page does and does not carry', () => {
  it('⛔⛔ NEVER renders the sealed submission or the visitor email', async () => {
    // The receipt echoed their answers once, at submit, to the browser that had
    // just typed them. A long-lived bearer URL must not widen that to anyone
    // the link reaches — and they came back to learn what HAPPENED, not what
    // they sent.
    const out = await drive({});
    expect(out.body).not.toContain('ENCRYPTED-BLOB-WITH-THEIR-ANSWERS');
    expect(out.body).not.toContain('ENCRYPTED-EMAIL');
  });

  it('carries the reference id and the submitted stamp', async () => {
    const out = await drive({});
    expect(out.body).toContain('sub-1');
    expect(out.body).toContain(new Date(NOW - 60_000).toISOString());
  });

  it('is noindex — a shared link must not become a search result', async () => {
    expect((await drive({})).body).toContain('noindex');
  });
});

describe('D-240 — the state projection', () => {
  it('received → in_progress → completed', () => {
    expect(projectLookupState(record())).toBe('received');
    expect(projectLookupState(record({
      resolved_target_kind: 'task', resolved_target_id: 'task-1',
    }), { done: false })).toBe('in_progress');
    expect(projectLookupState(record({
      resolved_target_kind: 'task', resolved_target_id: 'task-1',
    }), { done: true })).toBe('completed');
  });

  it('⛔⛔ `processed` DOES NOT MEAN COMPLETED — it means ingestion finished', () => {
    // The defect Codex found. The intake processor marks `processed` the moment
    // a submission is handed to the review workflow, with `resolved_target_*`
    // still null — its own comment says "nothing is materialized until the user
    // approves". So a request SITTING IN THE OWNER'S APPROVAL QUEUE was telling
    // the submitter their request had been completed.
    expect(projectLookupState(record({ processing_outcome: 'processed' })))
      .toBe('received');
    // And even once something IS materialized, `processed` alone does not promote
    // it — only the target saying `done` does.
    expect(projectLookupState(record({
      processing_outcome: 'processed',
      resolved_target_kind: 'task', resolved_target_id: 'task-1',
    }))).toBe('in_progress');
  });

  it('⚠ with NO completion reader the ceiling is `in_progress`, never `completed`', () => {
    // A substrate that cannot see the target must not claim the target finished.
    expect(projectLookupState(record({
      resolved_target_kind: 'task', resolved_target_id: 'task-1',
    }))).toBe('in_progress');
    expect(projectLookupState(record({
      resolved_target_kind: 'task', resolved_target_id: 'task-1',
    }), null)).toBe('in_progress');
  });

  it('⛔⛔ a SPAM classification reads as `received`, never as rejected', () => {
    // Telling a visitor their submission was classified as spam hands a bot the
    // honeypot oracle D-149's unconditional receipt exists to deny.
    for (const outcome of ['spam', 'rejected_domain', 'duplicate'] as const) {
      expect(projectLookupState(record({ processing_outcome: outcome }))).toBe('received');
    }
  });

  it('⚠ and the rendered copy for spam is byte-identical to a clean pending one', async () => {
    // The projection agreeing is not enough — the PAGE is what a bot reads.
    const clean = await drive({ found: record() });
    const spam = await drive({ found: record({ processing_outcome: 'spam' }) });
    expect(spam.body).toBe(clean.body);
  });
});

describe('D-240 slice 3b — a bound viewback recipe replaces the substrate status', () => {
  const block = { type: 'text', data: 'Shipped on Tuesday. Tracking: ABC123.' };

  it('the recipe output REPLACES the three-state copy', async () => {
    // The whole point of 3b: the owner's recipe decides what the submitter reads.
    const out = await drive({ run: async () => ({ kind: 'completed', render: [block], uses_ai: false }) });
    expect(out.status).toBe(200);
    expect(out.body).toContain('Shipped on Tuesday');
    expect(out.body).not.toContain('We have your request');
  });

  it('⛔⛔ hands the recipe the PROJECTED state, never the sealed submission', async () => {
    // The runner's input contract, asserted at the CALLER — the handler chooses
    // what to pass, so a leak would originate here. An author who could read the
    // visitor's answers could render them back onto a long-lived bearer page,
    // undoing slice 3's whole posture.
    let seen: Record<string, unknown> | undefined;
    await drive({
      run: async (input) => { seen = { ...input.record }; return { kind: 'no_door' }; },
    });
    expect(seen).toMatchObject({ reference_id: 'sub-1', state: 'received' });
    expect(JSON.stringify(seen)).not.toContain('ENCRYPTED');
  });

  it('⚠ a FAILED run degrades to the substrate status, and says so', async () => {
    // A submit refuses to show a page it cannot honour (D-207 slice 1c) because
    // it owes the visitor something. A viewback owes a STATUS, and the substrate
    // can always produce a true one — narrower is not a lie; a 404 for a live
    // request would be.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await drive({ run: async () => ({ kind: 'failed', errors: ['boom'] }) });
      expect(out.status).toBe(200);
      expect(out.body).toContain('We have your request');
      // ⛔ NOT SILENTLY: a door that stopped working must reach the owner, and
      // "the page still renders" is exactly how it would not.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('viewback recipe failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('degrades when the runner THROWS — a concurrency refusal is not a 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await drive({ run: async () => { throw new Error('busy'); } });
      expect(out.status).toBe(200);
      expect(out.body).toContain('We have your request');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('viewback recipe threw'));
    } finally {
      warn.mockRestore();
    }
  });

  it('⚠ `no_door` is SILENT — an unbound endpoint is normal, not a fault', async () => {
    // The permitting case for the two warnings above: if `no_door` also warned,
    // every server without a viewback recipe would fill its log with noise and a
    // real failure would be invisible in it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await drive({ run: async () => ({ kind: 'no_door' }) });
      expect(out.body).toContain('We have your request');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('an EMPTY render falls back too — a blank page is not an answer', async () => {
    const out = await drive({ run: async () => ({ kind: 'completed', render: [], uses_ai: false }) });
    expect(out.body).toContain('We have your request');
  });
});

describe('D-240 — path parsing', () => {
  it('accepts exactly one segment after the prefix', () => {
    expect(parseLookupSecretFromPath(`${RECEPTION_LOOKUP_PATH}/${SECRET}`)).toBe(SECRET);
  });

  it('⛔ refuses a deeper path — a prefix match would carry the secret onward', () => {
    expect(parseLookupSecretFromPath(`${RECEPTION_LOOKUP_PATH}/${SECRET}/edit`)).toBeNull();
  });

  it('refuses the bare prefix and unrelated paths', () => {
    expect(parseLookupSecretFromPath(RECEPTION_LOOKUP_PATH)).toBeNull();
    expect(parseLookupSecretFromPath(`${RECEPTION_LOOKUP_PATH}/`)).toBeNull();
    expect(parseLookupSecretFromPath('/reception/lookup-other/x')).toBeNull();
    expect(parseLookupSecretFromPath('/reception/intake/ep-1')).toBeNull();
  });
});

describe('D-240 viewback — the AI notice', () => {
  const block = { type: 'text', data: 'Shipped on Tuesday. Tracking: ABC123.' };
  const NOTICE = 'Parts of this page were produced using AI.';

  it('renders when the completed run used AI', async () => {
    const out = await drive({
      run: async () => ({ kind: 'completed', render: [block], uses_ai: true }),
    });
    expect(out.body).toContain(NOTICE);
  });

  it('⛔ is ABSENT when the same completed run used none', async () => {
    // Byte-for-byte the same page otherwise — the flag is the only variable.
    const out = await drive({
      run: async () => ({ kind: 'completed', render: [block], uses_ai: false }),
    });
    expect(out.body).toContain('Shipped on Tuesday');
    expect(out.body).not.toContain(NOTICE);
  });

  it('⛔⛔ is ABSENT on the FALLBACK page, which the substrate wrote', async () => {
    // The sharp case. A `failed` run falls back to the three-state substrate
    // copy, and a model may well have run before it failed — but the words the
    // visitor is reading were not produced by one. An AI notice over substrate
    // text is a false claim about the thing it sits on.
    const out = await drive({ run: async () => ({ kind: 'failed', errors: ['boom'] }) });
    expect(out.status).toBe(200);
    expect(out.body).not.toContain(NOTICE);
  });

  it('⛔ is ABSENT when no viewback recipe is bound at all', async () => {
    const out = await drive({ run: async () => ({ kind: 'no_door' }) });
    expect(out.body).not.toContain(NOTICE);
  });

  it('LEADS the recipe output rather than trailing it', async () => {
    // "At the latest at the time of first exposure" — before the content the
    // visitor came to read, not underneath it.
    const out = await drive({
      run: async () => ({ kind: 'completed', render: [block], uses_ai: true }),
    });
    expect(out.body.indexOf(NOTICE)).toBeLessThan(out.body.indexOf('Shipped on Tuesday'));
  });
});
