import { createMailWorkEvidence } from '../mail-work-evidence.js';
import {
  composeVendorEntityScope,
  CONNECTION_VENDOR_ENTITIES,
  partitionPriorToolCalls,
  type AIOutput,
  type ChatPriorToolCall,
  type ConnectionVendorEntity,
  type EnrichmentScope,
  type IngredientManifest,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { shouldSeedEntityValue } from '@recued/middleware-prompt-cache';
import {
  aliasIdentifierField,
  phoneMatchDigits,
  rawLedgerValuesInText,
} from '@recued/transforms';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  createPiiProtectMiddleware,
  readPiiEgressPlan,
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import { briefAsPriorToolCall } from '../chat-rolling-brief.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { buildBriefPrompt } from '../chat-rolling-brief.js';
import {
  createContactKnownValueIndexBuilder,
  RECALL_WITHHELD_MESSAGE,
  type RecallResolver,
} from '../chat-recall-index.js';
import { crmRecallSeedScopes } from '../canonical-pii-schemas.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';

const MANIFEST = {} as IngredientManifest;

const makePlan = (resolver: piiEgress.FieldPrivacyResolver): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
  resolver,
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

/** Build a hand-made `RecallResolver`: names/orgs go into the whole-warehouse A-C;
 *  emails/phones are TEXT-DRIVEN — `resolveIdentifiers` seeds one only when it is
 *  actually present in the result text, mirroring the real store-backed resolver
 *  (bounded by the text, never the warehouse). */
const recallResolver = ({
  names = [],
  orgs = [],
  emails = [],
  phones = [],
}: {
  readonly names?: readonly string[];
  readonly orgs?: readonly string[];
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
}): RecallResolver => ({
  nameOrgIndex: piiEgress.buildRecallIndex({ names, orgs, emails: [], phones: [] }),
  // A hand-built resolver is never degraded — it read nothing, so nothing could fail.
  isDegraded: () => false,
  resolveIdentifiers: (text) => [
    ...emails
      .filter((e) => text.includes(e))
      .map((value) => ({ kind: 'email' as const, value })),
    ...phones
      .filter((p) => text.includes(p))
      .map((value) => ({ kind: 'phone' as const, value })),
  ],
});

const withRecall = (
  plan: PiiEgressPlan,
  getIndex: () => RecallResolver | undefined = () =>
    recallResolver({ names: ['Diego Okafor'] }),
): PiiEgressPlan => ({
  ...plan,
  recall: { getIndex },
});

/** Run a prompt through the model-bound wire seam; capture the egress prompt. */
const egress = async (
  plan: PiiEgressPlan,
  prompt: string,
): Promise<{ rawPrompt: string; packet: Record<string, unknown> }> => {
  let rawPrompt = '';
  const real: ExecuteChatAiCall = async (_m, input) => {
    rawPrompt = String(input['llm.prompt']);
    return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
  };
  await wrapExecuteAiCallForPii(real, plan)(MANIFEST, { 'llm.prompt': prompt });
  let packet: Record<string, unknown> = {};
  try {
    packet = JSON.parse(rawPrompt) as Record<string, unknown>;
  } catch {
    /* non-JSON - leave empty */
  }
  return { rawPrompt, packet };
};

const memorySearchEntry = (outputString: string) => ({
  tool_name: 'memory.search',
  tier: 1,
  args: {},
  status: 'ok',
  result: { entries: [{ output_string: outputString, run_id: 'r1' }] },
  started_at: 0,
  completed_at: 1,
});

/** Build a prior-state prompt exactly as `composeChatMainTurnPromptBody` would —
 *  recall (`memory.search`) dispatches partition into the typed `recall_context`
 *  field, everything else stays in `prior_tool_calls`. The egress aliases each by
 *  field, so feeding the partitioned shape mirrors production. */
const priorPrompt = ({
  call,
  user_message = 'recall it',
  chat_tail = [],
}: {
  readonly call: Record<string, unknown>;
  readonly user_message?: string;
  readonly chat_tail?: readonly Record<string, unknown>[];
}): string => {
  const { prior, recall } = partitionPriorToolCalls([
    call as unknown as ChatPriorToolCall,
  ]);
  return JSON.stringify({
    available_tools: [],
    commitment_context: [],
    chat_tail,
    user_message,
    ...(recall.length > 0 ? { recall_context: recall } : {}),
    ...(prior.length > 0 ? { prior_tool_calls: prior } : {}),
  });
};

/** Read the first dispatch result's `output_string` from whichever typed field the
 *  composer routed it to — `recall_context` for a recall dispatch, else
 *  `prior_tool_calls`. */
const firstOutputString = (packet: Record<string, unknown>): string =>
  ((packet.recall_context ?? packet.prior_tool_calls) as Array<{
    result: { entries: Array<{ output_string: string }> };
  }>)[0]!.result.entries[0]!.output_string;

interface ContactScanRow {
  readonly email: string;
  readonly name?: string;
  readonly phone?: string;
  readonly company?: string;
}

/** A minimal in-memory `ContactStore` exposing only the methods the off-cap recall
 *  resolver uses: `count` (empty-warehouse gate), `listAllNamesAndCompanies` (the
 *  whole-warehouse A-C source), and `resolveRecallIdentifiers` (exact email-PK +
 *  `phoneMatchDigits`-form lookup, mirroring the real store). */
const fakeStore = (
  rows: ReadonlyArray<ContactScanRow>,
): ContactStore =>
  ({
    count: () => rows.length,
    listRecallAddressSeeds: () => ({ streets: [], domains: [] }),
    listAllNamesAndCompanies: () => ({
      names: rows.map((r) => r.name).filter((n): n is string => !!n),
      companies: rows.map((r) => r.company).filter((c): c is string => !!c),
    }),
    resolveRecallIdentifiers: ({
      emails,
      forms,
    }: {
      readonly emails: readonly string[];
      readonly forms: readonly string[];
    }) => {
      const formSet = new Set(forms);
      const outEmails = rows
        .filter((r) => emails.includes(r.email))
        .map((r) => r.email);
      const outPhones: string[] = [];
      for (const r of rows) {
        if (!r.phone) continue;
        const { full, national } = phoneMatchDigits(r.phone);
        const contactForms = [full, ...national].filter(
          (f): f is string => f !== undefined,
        );
        if (contactForms.some((f) => formSet.has(f))) outPhones.push(r.phone);
      }
      return { emails: outEmails, phones: outPhones };
    },
  }) as unknown as ContactStore;

describe('D-167 recall egress PII', () => {
  it('aliases memory.search result PII from the recall index with a fresh ledger and noop resolver', async () => {
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver));
    const { rawPrompt, packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('note from Diego Okafor') }),
    );

    expect(firstOutputString(packet)).toBe('note from pii.Person1');
    expect(rawPrompt).not.toContain('Diego Okafor');
  });

  it('seeds the ledger from recall_context before scanning non-recall prior_tool_calls', async () => {
    const plan = withRecall(
      makePlan(piiEgress.noopFieldPrivacyResolver),
      createContactKnownValueIndexBuilder(() =>
        fakeStore([{ email: 'diego@example.com', name: 'Diego Okafor' }]),
      ),
    );
    const { prior, recall } = partitionPriorToolCalls([
      memorySearchEntry('memory says Diego Okafor owns Apollo') as ChatPriorToolCall,
      {
        tool_name: 'mail.search',
        tier: 1,
        args: {},
        status: 'ok',
        result: { entries: [{ output_string: 'mail says Diego Okafor owns Apollo' }] },
        started_at: 2,
        completed_at: 3,
      } as ChatPriorToolCall,
    ]);
    const { rawPrompt, packet } = await egress(
      plan,
      JSON.stringify({
        available_tools: [],
        commitment_context: [],
        chat_tail: [],
        user_message: 'recall it',
        recall_context: recall,
        prior_tool_calls: prior,
      }),
    );

    expect(firstOutputString(packet)).toBe('memory says pii.Person1 owns Apollo');
    expect(
      (packet.prior_tool_calls as Array<{
        result: { entries: Array<{ output_string: string }> };
      }>)[0]!.result.entries[0]!.output_string,
    ).toBe('mail says pii.Person1 owns Apollo');
    expect(rawPrompt).not.toContain('Diego Okafor');
  });

  it('leaves the same empty-ledger memory.search result raw when no recall provider is wired', async () => {
    const plan = makePlan(piiEgress.noopFieldPrivacyResolver);
    const { packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('note from Diego Okafor') }),
    );

    expect(firstOutputString(packet)).toBe('note from Diego Okafor');
  });

  it('overlap-reveals a user-disclosed first-name fragment through egress', async () => {
    const plan = withRecall(
      makePlan(piiEgress.noopFieldPrivacyResolver),
      () => recallResolver({ names: ['Sarah Smith'] }),
    );
    const { packet } = await egress(
      plan,
      priorPrompt({
        call: memorySearchEntry('met Sarah Smith at expo'),
        user_message: 'who is Sarah',
      }),
    );

    expect(firstOutputString(packet)).toBe('met pii.Person1.sarah at expo');
  });

  it('uses only user-authored text for overlap disclosure', async () => {
    const userDisclosedPlan = withRecall(
      makePlan(piiEgress.noopFieldPrivacyResolver),
      () => recallResolver({ names: ['Sarah Smith'] }),
    );
    const userDisclosed = await egress(
      userDisclosedPlan,
      priorPrompt({
        call: memorySearchEntry('note about Sarah Smith'),
        user_message: 'what did I ask for?',
        chat_tail: [
          { role: 'user', content: 'remind me about Sarah' },
          { role: 'assistant', content: '...' },
        ],
      }),
    );

    expect(firstOutputString(userDisclosed.packet)).toBe('note about pii.Person1.sarah');

    const assistantOnlyPlan = withRecall(
      makePlan(piiEgress.noopFieldPrivacyResolver),
      () => recallResolver({ names: ['Sarah Smith'] }),
    );
    const assistantOnly = await egress(
      assistantOnlyPlan,
      priorPrompt({
        call: memorySearchEntry('note about Sarah Smith'),
        user_message: 'what did I ask for?',
        chat_tail: [{ role: 'assistant', content: 'Sarah was at expo' }],
      }),
    );

    expect(firstOutputString(assistantOnly.packet)).toBe('note about pii.Person1');
  });

  /** ⛔⛔ INVERTED 2026-08-24 — this asserted the OPPOSITE, and the old behaviour
   *  was the leak. The whole-warehouse resolver was scoped to `memory.*` recall, so
   *  aliasing engaged only when the turn NAMED a contact or READ one via
   *  `contact.search`; a `mail.search` result carrying a known contact reached the
   *  model RAW. Measured: bench 183 aliased the same registered contact in 67
   *  packets and sent it raw in 63 — of the SAME run, the raw ones preceding its
   *  first `contact.search`. The resolver now covers `prior_tool_calls` too. */
  it('applies the recall index to NON-memory prior_tool_calls entries too', async () => {
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver));
    const { packet } = await egress(
      plan,
      priorPrompt({
        call: {
          ...memorySearchEntry('note from Diego Okafor'),
          tool_name: 'contact.search',
        },
      }),
    );

    // A warehouse-known name in a contact.search result is aliased now, exactly as
    // it already was inside a memory.search result.
    expect(firstOutputString(packet)).not.toBe('note from Diego Okafor');
    expect(firstOutputString(packet)).toMatch(/pii\.[A-Za-z]+\d+/);
  });

  /** ⚠ NARROWED 2026-08-24. The lazy-build contract still holds, but its SCOPE
   *  moved: a packet with NEITHER recall context NOR tool results still pays
   *  nothing. A packet WITH tool results now builds the index, because the gate
   *  cannot know whether a result carries PII without it — the cost the widening
   *  buys protection with, stated rather than hidden.
   *  ⛔ UNMEASURED AT SCALE: the code's own figure is ~180ms @ 50k contacts,
   *  memoised once per turn. The bench warehouse is far smaller and its turns are
   *  dominated by provider latency, so the bench cannot see it. */
  it('keeps a packet with NO recall context and NO tool results byte-identical', async () => {
    let builds = 0;
    const inputPacket = {
      available_tools: [],
      commitment_context: [],
      chat_tail: [],
      user_message: 'hello',
      prior_tool_calls: [],
    };
    const prompt = JSON.stringify(inputPacket);
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), () => {
      builds += 1;
      return recallResolver({ names: ['Diego Okafor'] });
    });

    const { rawPrompt, packet } = await egress(plan, prompt);

    expect(rawPrompt).toBe(prompt);
    expect(packet).toEqual(inputPacket);
    expect(builds).toBe(0);
  });

  it('restores a recall-seeded alias in the wrapped executor result body', async () => {
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver));
    let rawPrompt = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      rawPrompt = String(input['llm.prompt']);
      return {
        body: {
          response: 'pii.Person1 owns it',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(real, plan)(MANIFEST, {
      'llm.prompt': priorPrompt({ call: memorySearchEntry('note from Diego Okafor') }),
    });
    const packet = JSON.parse(rawPrompt) as Record<string, unknown>;

    expect(firstOutputString(packet)).toBe('note from pii.Person1');
    expect((result.body as AIOutput).response).toBe('Diego Okafor owns it');
  });

  // THE HARD INVARIANT. The module's stance is "aliasing is allowed to MISS; the HARD
  // invariant is RESTORE" — so an UNKNOWN email, which we now alias for the first
  // time, must round-trip. It does, because `aliasEmail` is value-keyed and store-free:
  // the ledger row it allocates restores exactly like a known contact's. If it did not,
  // the model would say `m1@d1.invalid` and Recued would try to email a `.invalid` host.
  it('RESTORES an unknown (non-contact) email the model uses — the hard invariant', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() =>
      fakeStore([{ email: 'diego@x.com', name: 'Diego Okafor' }]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);

    let rawPrompt = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      rawPrompt = String(input['llm.prompt']);
      // The model only ever sees the alias — it echoes it back.
      return {
        body: {
          response: 'I will email m1@d1.invalid',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(real, plan)(MANIFEST, {
      'llm.prompt': priorPrompt({
        call: memorySearchEntry('Escalate to bob@randomcorp.com'),
      }),
    });

    // Out: the real address never reached the model.
    expect(rawPrompt).not.toContain('bob@randomcorp.com');
    // Back: the alias restored to the REAL address, so the action is executable.
    expect((result.body as AIOutput).response).toBe('I will email bob@randomcorp.com');
  });

  it('records recall-path content replacements in the redaction summary', async () => {
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex: () => recallResolver({ names: ['Diego Okafor'] }),
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    const plan = readPiiEgressPlan(
      state as Parameters<typeof readPiiEgressPlan>[0],
    );

    expect(plan).toBeDefined();
    await egress(
      plan!,
      priorPrompt({ call: memorySearchEntry('note from Diego Okafor') }),
    );

    expect(plan!.summary.value.counts.content_text_replacements ?? 0).toBeGreaterThan(0);
  });

  it('builds the recall index at most once per turn across tool-loop reinvokes', async () => {
    let builds = 0;
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex: () => {
        builds += 1;
        return recallResolver({ names: ['Diego Okafor'] });
      },
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    const plan = readPiiEgressPlan(state as Parameters<typeof readPiiEgressPlan>[0])!;

    // Two reinvokes reuse the SAME plan object, as the tool loop does — the
    // per-plan memo must build the whole-warehouse index only once.
    await egress(plan, priorPrompt({ call: memorySearchEntry('note from Diego Okafor') }));
    await egress(plan, priorPrompt({ call: memorySearchEntry('again from Diego Okafor') }));

    expect(builds).toBe(1);
  });
});

describe('createContactKnownValueIndexBuilder', () => {
  it('builds an index from contact rows that recall egress aliases against', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() =>
      fakeStore([
        {
          email: 'diego@x.com',
          name: 'Diego Okafor',
          company: 'Acme',
          phone: '+14155550199',
        },
      ]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { packet } = await egress(
      plan,
      priorPrompt({
        call: memorySearchEntry(
          'Diego Okafor at Acme uses diego@x.com and +14155550199',
        ),
      }),
    );

    expect(firstOutputString(packet)).toBe(
      'pii.Person1 at pii.Org1 uses m1@d1.invalid and pii.Phone1.us',
    );
  });

  // ── The three tests below USED to pin `undefined` on an empty / missing /
  // throwing contact store, on the premise "no contacts ⇒ nothing to alias".
  // That premise is now FALSE: the EMAIL leg is store-free (an email is PII whether
  // or not it is a known contact), so returning `undefined` would silently drop email
  // shielding exactly where it matters most — a server with no personal contact graph
  // but a memory pool full of customer emails (the D-196 seller shape). Each now pins
  // the corrected contract: DEGRADE the name/org automaton to empty, KEEP the emails.

  it('an EMPTY contact scan still shields emails (degrades the automaton, not the resolver)', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() => fakeStore([]));
    expect(getIndex()).toBeDefined();

    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('ping nobody@nowhere.com about it') }),
    );
    expect(firstOutputString(packet)).toBe('ping m1@d1.invalid about it');
  });

  it('NO contact store still shields emails (the email leg needs no store)', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() => undefined);
    expect(getIndex()).toBeDefined();

    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('ping nobody@nowhere.com about it') }),
    );
    expect(firstOutputString(packet)).toBe('ping m1@d1.invalid about it');
  });

  it('a THROWING contact scan does not CRASH — but the result is now WITHHELD, not egressed', async () => {
    // ⚠ REVERSED (2026-07-12). This used to assert the throw failed OPEN: the body still went
    // to the model, shielded only by the store-free email leg. That is a LEAK — every name,
    // phone and street in the memory went out unaliased and nothing failed or logged. A read
    // error means the values EXIST and we could not see them, so an empty seed set is a lie.
    // The builder still must not crash; the EGRESS is what now fails closed.
    const getIndex = createContactKnownValueIndexBuilder(
      () =>
        ({
          count: () => 1,
          listRecallAddressSeeds: () => ({ streets: [], domains: [] }),
          listAllNamesAndCompanies: () => {
            throw new Error('scan failed');
          },
          resolveRecallIdentifiers: () => {
            throw new Error('resolve failed');
          },
        }) as unknown as ContactStore,
    );

    expect(() => getIndex()).not.toThrow();
    expect(getIndex()).toBeDefined();
    expect(getIndex()!.isDegraded()).toBe(true);

    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { rawPrompt, packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('Ilana Vukovic, ping nobody@nowhere.com') }),
    );
    // Nothing from the body reaches the model — not even the part the email leg could shield.
    expect(rawPrompt).not.toContain('Ilana Vukovic');
    expect(rawPrompt).not.toContain('nobody@nowhere.com');
    expect(JSON.stringify(packet.recall_context)).toContain('withheld');
  });

  // ────────────────────────────────────────────────────────────────
  // The leak this closes: an email in a recalled MEMORY BODY that resolves to no
  // contact. `memory.search` now returns up to 16 KB of FREE TEXT, and a memory can
  // name anyone — such a value lives in NO warehouse entity, so widening the entity
  // index provably cannot reach it. It used to be extracted, looked up, MISSED, and
  // egressed RAW.
  // ────────────────────────────────────────────────────────────────

  it('aliases an email that matches NO contact (the free-text recall leak)', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() =>
      // A populated store — so the resolver builds for the RIGHT reason, and the miss
      // below is genuinely "this email is not a contact", not "there are no contacts".
      fakeStore([{ email: 'diego@x.com', name: 'Diego Okafor' }]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { packet, rawPrompt } = await egress(
      plan,
      priorPrompt({
        call: memorySearchEntry('Escalate to bob@randomcorp.com — he owns renewals'),
      }),
    );

    // Bob is a real person who is simply not in the address book. He must NOT egress raw.
    expect(rawPrompt).not.toContain('bob@randomcorp.com');
    expect(firstOutputString(packet)).toBe(
      'Escalate to m1@d1.invalid — he owns renewals',
    );
  });

  it('still aliases a KNOWN contact email (no regression)', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() =>
      fakeStore([{ email: 'diego@x.com', name: 'Diego Okafor' }]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { rawPrompt } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('reply to diego@x.com') }),
    );
    expect(rawPrompt).not.toContain('diego@x.com');
  });

  // ⚠ THE CORRUPTION GUARD. Phones deliberately stay KNOWN-ONLY: the candidate
  // `forms` are bare DIGIT-STRINGS (the extractor keeps digit tokens, not just
  // phone-shaped runs), so seeding them unconditionally the way emails are would
  // alias an invoice number / a year into a phone alias — corrupting the model's
  // reasoning rather than protecting anything. If this test ever goes red because
  // someone made phones unconditional, that is the bug, not the test.
  it('does NOT alias a bare digit-string (invoice number / year) as a phone', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() =>
      fakeStore([{ email: 'diego@x.com', name: 'Diego Okafor', phone: '+14155550199' }]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('invoice 90210 closed in 2026') }),
    );
    // Untouched — neither digit-run is a known phone form.
    expect(firstOutputString(packet)).toBe('invoice 90210 closed in 2026');
  });

  it('still aliases a KNOWN phone (the store lookup is what disambiguates a digit-run)', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() =>
      fakeStore([{ email: 'diego@x.com', name: 'Diego Okafor', phone: '+14155550199' }]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { rawPrompt } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('call +14155550199 today') }),
    );
    expect(rawPrompt).not.toContain('14155550199');
  });

  it('withholds common single-token names while retaining distinctive names', async () => {
    expect(shouldSeedEntityValue('Will')).toBe(false);
    expect(shouldSeedEntityValue('Xiomara')).toBe(true);
    const getIndex = createContactKnownValueIndexBuilder(() =>
      fakeStore([
        { email: 'will@x.com', name: 'Will' },
        { email: 'xiomara@x.com', name: 'Xiomara' },
      ]),
    );
    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { packet } = await egress(
      plan,
      priorPrompt({ call: memorySearchEntry('Will met Xiomara') }),
    );

    expect(firstOutputString(packet)).toBe('Will met pii.Person1');
  });

  it('resolves recall identifiers only from identifiers present in the recalled text', async () => {
    const db = new Database(':memory:');
    try {
      const store = createContactStore(db);
      const contactA = {
        email: 'athena@alpha.example.com',
        phone: '+14155550199',
      };
      const contactB = {
        email: 'bruno@beta.example.com',
        phone: '+14155550222',
      };
      store.upsertManual({ ...contactA, name: 'Athena Alpha', company: 'Alpha Example' }, 2_000);
      store.upsertManual({ ...contactB, name: 'Bruno Beta', company: 'Beta Example' }, 2_001);
      const plan = withRecall(
        makePlan(piiEgress.noopFieldPrivacyResolver),
        createContactKnownValueIndexBuilder(() => store),
      );

      const { packet } = await egress(
        plan,
        priorPrompt({
          call: memorySearchEntry(
            `Reach ${contactA.email} or ${contactA.phone}; no other identifier is present.`,
          ),
        }),
      );
      const output = firstOutputString(packet);
      const ledgerRealValues = [...plan.ledger.byKindRealValue.values()]
        .map((entry) => entry.real_value);

      expect(output).toContain('m1@d1.invalid');
      expect(output).toContain('pii.Phone1.us');
      expect(output).not.toContain(contactA.email);
      expect(output).not.toContain(contactA.phone);
      expect(ledgerRealValues).toContain(contactA.email);
      expect(ledgerRealValues).toContain(contactA.phone);
      expect(ledgerRealValues).not.toContain(contactB.email);
      expect(ledgerRealValues).not.toContain(contactB.phone);
    } finally {
      db.close();
    }
  });
});

/** D-167 recall path, Tier 2 — the CRM mirror as a recall seed source.
 *
 *  THE LEAK THIS CLOSES: a CRM contact is NOT a warehouse contact. `ContactSource` is
 *  `email_from | email_to | calendar_attendee | manual` — no CRM member — and nothing
 *  in the CRM ingest calls `observe`/`upsertManual`. So a person who lives only in the
 *  CRM (never emailed you, never on an invite) has NO `contacts` row, was invisible to
 *  the contact-derived A-C, and their name + phone egressed RAW out of a recalled
 *  memory body. Every test below runs the REAL mirror store, the REAL contact store,
 *  and the REAL egress — a mocked store could not catch a cap or a form drift, which
 *  are the two ways this leaks. */
describe('createContactKnownValueIndexBuilder — CRM mirror (Tier 2)', () => {
  const HUBSPOT_CONTACT = composeVendorEntityScope('hubspot', 'contact');
  const HUBSPOT_COMPANY = composeVendorEntityScope('hubspot', 'company');
  const HUBSPOT_DEAL = composeVendorEntityScope('hubspot', 'deal');
  const PIPEDRIVE_PERSON = composeVendorEntityScope('pipedrive', 'person');

  /** A real mirror + a real (EMPTY unless told otherwise) contact warehouse on one
   *  in-memory db — the exact shape of the leak: CRM rows, zero contacts. */
  const withStores = async (
    seed: (mirror: CrmRecordMirrorStore, contacts: ContactStore) => void,
    run: (
      getIndex: () => RecallResolver | undefined,
      plan: PiiEgressPlan,
      contacts: ContactStore,
    ) => Promise<void>,
  ): Promise<void> => {
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      ensureCrmRecordMirrorSchema(db);
      const mirror = createCrmRecordMirrorStore(db);
      seed(mirror, contacts);
      const getIndex = createContactKnownValueIndexBuilder(
        () => contacts,
        () => mirror,
      );
      await run(
        getIndex,
        withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex),
        contacts,
      );
    } finally {
      db.close();
    }
  };

  /** Upsert one mirror record. `meta` carries the two stamping fields the serializer
   *  demands; the rest is the canonical projection the reconcilers write. */
  const mirrorRow = (
    mirror: CrmRecordMirrorStore,
    scope: EnrichmentScope,
    target_id: string,
    fields: Record<string, unknown>,
  ): void =>
    mirror.upsert({
      scope,
      target_id,
      meta: { snapshot_at: 1, snapshot_hash: `fnv1a:${target_id}`, ...fields },
      now: 1,
    });

  it('aliases a CRM-ONLY person — name + phone — with ZERO contacts in the warehouse', async () => {
    await withStores(
      (mirror, contacts) => {
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_1', {
          name: 'Ilana Vukovic',
          phone: '+14155550143',
          company: 'Northwind Traders',
          email: 'ilana@northwind.example',
        });
        // The premise, asserted rather than assumed: the CRM person is NOT a contact.
        expect(contacts.count()).toBe(0);
      },
      async (_getIndex, plan) => {
        const { packet, rawPrompt } = await egress(
          plan,
          priorPrompt({
            call: memorySearchEntry(
              'Ilana Vukovic at Northwind Traders — reach her on +14155550143 or ilana@northwind.example',
            ),
          }),
        );

        // Every one of the four kinds is shielded, from a warehouse with no contacts.
        expect(firstOutputString(packet)).toBe(
          'pii.Person1 at pii.Org1 — reach her on pii.Phone1.us or m1@d1.invalid',
        );
        expect(rawPrompt).not.toContain('Ilana Vukovic');
        expect(rawPrompt).not.toContain('Northwind Traders');
        expect(rawPrompt).not.toContain('14155550143');
        expect(rawPrompt).not.toContain('ilana@northwind.example');
      },
    );
  });

  it('seeds PAST the 200-row list() cap — the uncapped projection is load-bearing', async () => {
    // `CrmRecordMirrorStore.list()` clamps at MIRROR_MAX_LIMIT (200). If the seed build
    // is ever reimplemented over it, the 201st+ CRM contact silently stops being
    // aliased and NOTHING fails — under-returning here is a LEAK, not a smaller answer.
    // Pinned at the STORE level so the oracle is exact: `list()` cannot see all 250
    // rows no matter what limit it is handed, `listMetaRows` always does.
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      ensureCrmRecordMirrorSchema(db);
      const mirror = createCrmRecordMirrorStore(db);
      for (let i = 0; i < 250; i += 1) {
        mirror.upsert({
          scope: HUBSPOT_CONTACT,
          target_id: `hubspot_contact_${i}`,
          meta: {
            snapshot_at: 1,
            snapshot_hash: `fnv1a:${i}`,
            name: `Zephyrina Quintanilla${i}`,
          },
          now: 1,
        });
      }

      // The contrast, stated outright: the capped read is what a naive seed build would
      // have used, and it is 50 people short.
      expect(mirror.list(HUBSPOT_CONTACT, { limit: 100_000 })).toHaveLength(200);
      expect(mirror.listMetaRows(HUBSPOT_CONTACT, ['name'])).toHaveLength(250);

      // …and end-to-end: a person beyond the cap is still aliased out of a recall.
      const getIndex = createContactKnownValueIndexBuilder(
        () => contacts,
        () => mirror,
      );
      const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
      const { packet } = await egress(
        plan,
        priorPrompt({ call: memorySearchEntry('spoke to Zephyrina Quintanilla249') }),
      );
      expect(firstOutputString(packet)).toBe('spoke to pii.Person1');
    } finally {
      db.close();
    }
  });

  it('RESTORES a CRM-only person the model replies with — the hard invariant', async () => {
    // D-167's stance is "aliasing may MISS; RESTORE may not". A CRM phone that aliases
    // out but fails to come back would have Recued dial `pii.Phone1.us`.
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_1', {
          name: 'Ilana Vukovic',
          phone: '+14155550143',
        });
      },
      async (_getIndex, plan) => {
        let seenByModel = '';
        const real: ExecuteChatAiCall = async (_m, input) => {
          seenByModel = String(input['llm.prompt']);
          // The model only ever saw the aliases — it replies with them verbatim.
          return {
            body: {
              response: 'I will call pii.Person1 on pii.Phone1.us',
              events: [],
              tool_calls: [],
            } satisfies AIOutput,
          };
        };
        const out = await wrapExecuteAiCallForPii(real, plan)(MANIFEST, {
          'llm.prompt': priorPrompt({
            call: memorySearchEntry('Ilana Vukovic — +14155550143'),
          }),
        });

        expect(seenByModel).not.toContain('Ilana Vukovic');
        expect(seenByModel).not.toContain('14155550143');
        // …and the reply comes back as the REAL values, ready to act on.
        expect((out.body as AIOutput).response).toBe(
          'I will call Ilana Vukovic on +14155550143',
        );
      },
    );
  });

  it('does NOT seed a DEAL name — a deal title is not a person or an org', async () => {
    // `meta.name` means three different things by `crm_alias`: a PERSON on a contact,
    // an ORG on an account, a TITLE on a deal. Seeding the title would alias deal
    // names in prose for zero protective gain, so `deal` seeds nothing.
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_DEAL, 'hubspot_deal_1', {
          name: 'Quarterly Renewal Negotiation',
          owner: 'hubspot_owner_id:99',
        });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({
            call: memorySearchEntry('Quarterly Renewal Negotiation slipped a week'),
          }),
        );
        expect(firstOutputString(packet)).toBe(
          'Quarterly Renewal Negotiation slipped a week',
        );
      },
    );
  });

  it('seeds an ACCOUNT name as an org', async () => {
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_COMPANY, 'hubspot_company_1', {
          name: 'Northwind Traders',
          domain: 'northwind.example',
        });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('renewal risk at Northwind Traders') }),
        );
        expect(firstOutputString(packet)).toBe('renewal risk at pii.Org1');
      },
    );
  });

  it('covers the GENERIC reconciler shape — pipedrive first_name / last_name', async () => {
    // The bespoke HubSpot/Salesforce reconcilers project only a concatenated `name`;
    // the generic one (Pipedrive + any pack CRM) mirrors the registry keys verbatim, so
    // the seed list carries all three and an absent key json_extracts to NULL for free.
    await withStores(
      (mirror) => {
        mirrorRow(mirror, PIPEDRIVE_PERSON, 'pipedrive_person_1', {
          first_name: 'Bartholomew',
          last_name: 'Nakagawa',
        });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('Bartholomew and Nakagawa both signed') }),
        );
        expect(firstOutputString(packet)).toBe('pii.Person1 and pii.Person2 both signed');
      },
    );
  });

  it('does NOT alias a bare digit-string as a CRM phone (the corruption guard holds)', async () => {
    // The candidate `forms` are bare digit-strings, so an unconditional phone leg would
    // turn an invoice number into `pii.PhoneN`. The KNOWN-phone lookup is what
    // disambiguates a digit-run — widening the source to the CRM must not weaken it.
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_1', {
          name: 'Ilana Vukovic',
          phone: '+14155550143',
        });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('invoice 90210 closed in 2026') }),
        );
        expect(firstOutputString(packet)).toBe('invoice 90210 closed in 2026');
      },
    );
  });

  it('withholds a common single-token CRM org name (B4 still gates the CRM leg)', async () => {
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_COMPANY, 'hubspot_company_1', { name: 'Gap' });
        mirrorRow(mirror, HUBSPOT_COMPANY, 'hubspot_company_2', { name: 'Datadog' });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('mind the Gap, ask Datadog') }),
        );
        expect(firstOutputString(packet)).toBe('mind the Gap, ask pii.Org1');
      },
    );
  });

  it('seeds a PACK-DECLARED CRM vendor (LIVE registry, not the frozen built-ins)', async () => {
    // THE LEAK THIS PINS (codex-found): `vendorEntitiesFromComposition` lifts a
    // 3rd-party CRM pack's entities into an "ephemeral per-install registry, NEVER the
    // module-level boot-validated one" — while the housekeeping reconciler walks the
    // LIVE registry and so really does write `crm_record_mirror` rows for that vendor.
    // Enumerating the frozen `CONNECTION_VENDOR_ENTITIES` left those scopes UNSEEN:
    // rows present, never seeded, that person's name + phone RAW to the model. Pipedrive
    // MASKED it (a pack AND a hardcoded built-in) — only a genuinely 3rd-party vendor
    // like Zoho / Dynamics exposes it.
    const ZOHO_CONTACT = composeVendorEntityScope('zoho', 'contact');
    // Premise, asserted not assumed: zoho is in NO built-in registry entry.
    expect(CONNECTION_VENDOR_ENTITIES.some((e) => e.vendor === 'zoho')).toBe(false);

    // Shaped exactly as `vendorEntitiesFromComposition` lifts a pack entity: a plain
    // object built directly (NOT through `buildConnectionVendorEntity`), carrying the
    // composed `scope` + the `crm_alias` that makes it a CRM entity at all.
    const liveRegistry: ReadonlyArray<ConnectionVendorEntity> = [
      ...CONNECTION_VENDOR_ENTITIES,
      {
        vendor: 'zoho',
        entity: 'contact',
        scope: ZOHO_CONTACT,
        display_name: 'Zoho Contact',
        crm_alias: 'contact',
        meta_fields: [
          { key: 'name', type: 'string', source_path: 'Full_Name', description: 'name' },
          { key: 'phone', type: 'string', source_path: 'Phone', description: 'phone' },
        ],
      },
    ];

    // The frozen built-ins do NOT enumerate zoho — the leak, stated outright.
    expect(crmRecallSeedScopes().map((s) => s.scope)).not.toContain(ZOHO_CONTACT);
    // The LIVE registry does.
    expect(crmRecallSeedScopes(liveRegistry).map((s) => s.scope)).toContain(ZOHO_CONTACT);

    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      ensureCrmRecordMirrorSchema(db);
      const mirror = createCrmRecordMirrorStore(db);
      mirror.upsert({
        scope: ZOHO_CONTACT,
        target_id: 'zoho_contact_1',
        meta: {
          snapshot_at: 1,
          snapshot_hash: 'fnv1a:z1',
          name: 'Ilana Vukovic',
          phone: '+14155550143',
        },
        now: 1,
      });

      const getIndex = createContactKnownValueIndexBuilder(
        () => contacts,
        () => mirror,
        () => liveRegistry,
      );
      const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
      const { packet, rawPrompt } = await egress(
        plan,
        priorPrompt({ call: memorySearchEntry('Ilana Vukovic — +14155550143') }),
      );
      expect(firstOutputString(packet)).toBe('pii.Person1 — pii.Phone1.us');
      expect(rawPrompt).not.toContain('Ilana Vukovic');
      expect(rawPrompt).not.toContain('14155550143');
    } finally {
      db.close();
    }
  });

  it('does NOT seed a name synthesized from the email local-part (the corruption guard)', async () => {
    // Adversarial-review find. The reconcilers SYNTHESIZE `meta.name` from the email
    // local-part when a contact has no first/last name (`constructContactName`; the
    // registry says so outright — `fallback_transform: 'local_part'`). So a CRM row for
    // `sales@acme.com` projects the "name" `sales`. Seeding that as a PERSON puts the
    // bare token into the whole-warehouse automaton and aliases EVERY occurrence in
    // recalled prose. B4 does NOT save us — `sales`/`support`/`billing` are all absent
    // from the common-word list. This test is the tripwire: if it goes red, the model is
    // being handed mangled prose.
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_1', {
          email: 'sales@acme.example',
          name: 'sales', // ← the synthesized placeholder, not a person
        });
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_2', {
          email: 'support@acme.example',
          name: 'support',
        });
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_3', {
          email: 'billing@acme.example',
          name: 'billing',
        });
        // …while a REAL person on the same CRM must still be shielded.
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_4', {
          email: 'iv@acme.example',
          name: 'Ilana Vukovic',
        });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({
            call: memorySearchEntry(
              'Q3 sales were up; the support team flagged billing — Ilana Vukovic confirmed',
            ),
          }),
        );
        // The prose survives intact; only the real person is aliased.
        expect(firstOutputString(packet)).toBe(
          'Q3 sales were up; the support team flagged billing — pii.Person1 confirmed',
        );
      },
    );
  });

  it('a mononymous contact still seeds (the guard is surgical, not a blanket single-token ban)', async () => {
    await withStores(
      (mirror) => {
        // Her name is NOT her local-part, so it is a real name and must shield.
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_1', {
          email: 'c.bono@acme.example',
          name: 'Xiomara',
        });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('Xiomara signed off') }),
        );
        expect(firstOutputString(packet)).toBe('pii.Person1 signed off');
      },
    );
  });

  it('does NOT seed an all-digit name or org', async () => {
    await withStores(
      (mirror) => {
        mirrorRow(mirror, HUBSPOT_CONTACT, 'hubspot_contact_1', { name: '90210' });
        mirrorRow(mirror, HUBSPOT_COMPANY, 'hubspot_company_1', { name: '2026' });
      },
      async (_getIndex, plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('invoice 90210 closed in 2026') }),
        );
        expect(firstOutputString(packet)).toBe('invoice 90210 closed in 2026');
      },
    );
  });

  it('a THROWING mirror does not CRASH — but the result is now WITHHELD, not egressed', async () => {
    // ⚠ REVERSED (2026-07-12), same reason as the contact-scan case above. A mirror read error
    // means its CRM people are unshielded AND unknowable — we cannot even say who we missed —
    // so the memory body must not go out. Fail closed on the VALUE, never on the turn.
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      contacts.upsertManual({ email: 'diego@x.com', name: 'Diego Okafor' }, 2_000);
      const getIndex = createContactKnownValueIndexBuilder(
        () => contacts,
        () =>
          ({
            listMetaRows: () => {
              throw new Error('mirror scan failed');
            },
          }) as unknown as CrmRecordMirrorStore,
      );
      expect(getIndex()).toBeDefined();
      expect(getIndex()!.isDegraded()).toBe(true);

      const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
      const { rawPrompt } = await egress(
        plan,
        priorPrompt({
          call: memorySearchEntry('Diego Okafor mailed nobody@nowhere.com'),
        }),
      );
      expect(rawPrompt).not.toContain('Diego Okafor');
      expect(rawPrompt).not.toContain('nobody@nowhere.com');
      expect(rawPrompt).toContain('withheld');
    } finally {
      db.close();
    }
  });

  it('NO mirror wired still shields contacts (a server with no CRM degrades cleanly)', async () => {
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      contacts.upsertManual({ email: 'diego@x.com', name: 'Diego Okafor' }, 2_000);
      // One-arg call — the pre-Tier-2 signature must keep working.
      const getIndex = createContactKnownValueIndexBuilder(() => contacts);
      const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
      const { packet } = await egress(
        plan,
        priorPrompt({ call: memorySearchEntry('Diego Okafor is out') }),
      );
      expect(firstOutputString(packet)).toBe('pii.Person1 is out');
    } finally {
      db.close();
    }
  });
});

describe('CRM_RECALL_SEED_FIELDS / crmRecallSeedScopes', () => {
  it('enumerates contact + account scopes across every CRM vendor, and never a deal', async () => {
    const scopes = crmRecallSeedScopes();
    const ids = scopes.map((s) => s.scope);

    // Registry-driven: Pipedrive rides the GENERIC reconciler with zero per-vendor
    // code, so it must appear here without anyone adding it to a list.
    expect(ids).toContain(composeVendorEntityScope('hubspot', 'contact'));
    expect(ids).toContain(composeVendorEntityScope('salesforce', 'contact'));
    expect(ids).toContain(composeVendorEntityScope('pipedrive', 'person'));
    expect(ids).toContain(composeVendorEntityScope('hubspot', 'company'));
    expect(ids).toContain(composeVendorEntityScope('salesforce', 'account'));
    expect(ids).toContain(composeVendorEntityScope('pipedrive', 'organization'));

    // Deals seed nothing, so they are dropped rather than scanned for no reason.
    expect(ids).not.toContain(composeVendorEntityScope('hubspot', 'deal'));
    expect(ids).not.toContain(composeVendorEntityScope('salesforce', 'opportunity'));
    expect(ids).not.toContain(composeVendorEntityScope('pipedrive', 'deal'));

    // Every enumerated scope actually contributes at least one key.
    for (const { fields } of scopes) {
      expect(fields.names.length + fields.orgs.length + fields.phones.length).toBeGreaterThan(0);
    }
  });

  it('`owner` is never a seed key — it is an opaque vendor id, not a person', async () => {
    // `meta.owner` is `hubspot_owner_id:123` / `salesforce_user:…`; no reconciler
    // resolves it to a mailbox (`resolveOwnerMailbox` returns null for both prefixes),
    // so there is no PII in it to shield.
    for (const { fields } of crmRecallSeedScopes()) {
      expect([...fields.names, ...fields.orgs, ...fields.phones]).not.toContain('owner');
    }
  });
});

/** D-167 recall path — STREET LINES + KNOWN DOMAINS.
 *
 *  Two gaps, and they are NOT symmetric — the asymmetry is the design:
 *    · STREET LINE — seeded into the same A-C as names/orgs. Multi-token and distinctive, so
 *      the automaton matches it safely. The POSTCODE is never seeded (all digits → it collides
 *      with invoice numbers) and neither is city/state/country: those stay VISIBLE, because the
 *      owner's ruling is that we WANT the LLM location-aware.
 *    · DOMAIN — KNOWN-ONLY, the PHONE posture, not the EMAIL posture. An email is PII whatever
 *      the address book says; a URL usually is NOT. Seeding every URL would alias
 *      `docs.python.org` and blind the model to public links. */
describe('createContactKnownValueIndexBuilder — street lines + known domains', () => {
  const withContact = async (
    seed: (contacts: ContactStore) => void,
    run: (plan: PiiEgressPlan) => Promise<void>,
  ): Promise<void> => {
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      seed(contacts);
      const getIndex = createContactKnownValueIndexBuilder(() => contacts);
      await run(withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex));
    } finally {
      db.close();
    }
  };

  const ILANA = {
    email: 'ilana@northwind.example',
    name: 'Ilana Vukovic',
    mailing_address: {
      address1: '1600 Amphitheatre Parkway',
      city: 'Mountain View',
      state: 'CA',
      zip: '94043',
    },
  } as unknown as Parameters<ContactStore['upsertManual']>[0];

  it('aliases a STREET LINE recalled from a memory body', async () => {
    await withContact(
      (c) => c.upsertManual(ILANA, 2_000),
      async (plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('met her at 1600 Amphitheatre Parkway') }),
        );
        expect(firstOutputString(packet)).toBe('met her at pii.Address1');
      },
    );
  });

  it('leaves the POSTCODE and the CITY/STATE alone — the location-awareness ruling', async () => {
    // The postcode is never an A-C seed (all digits → invoice-number collision), and
    // city/state/country stay VISIBLE on purpose: a model that cannot see `Mountain View, CA`
    // cannot reason about timezone / hours / jurisdiction. This is a DESIGN PREFERENCE, not a
    // miss — do not "tighten" it.
    await withContact(
      (c) => c.upsertManual(ILANA, 2_000),
      async (plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('she is in Mountain View, CA 94043; invoice 94043 paid') }),
        );
        expect(firstOutputString(packet)).toBe(
          'she is in Mountain View, CA 94043; invoice 94043 paid',
        );
      },
    );
  });

  it('aliases a URL at a KNOWN domain (scheme + path preserved) and leaves a PUBLIC one raw', async () => {
    await withContact(
      (c) => c.upsertManual(ILANA, 2_000),
      async (plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({
            call: memorySearchEntry(
              'portal https://northwind.example/login; bare northwind.example/x; docs https://docs.python.org/3/library',
            ),
          }),
        );
        const out = firstOutputString(packet);
        // The known domain aliases in EVERY layout, keeping scheme + path…
        expect(out).toContain('https://d1.invalid/login');
        expect(out).toContain('d1.invalid/x');
        expect(out).not.toContain('northwind.example');
        // …and the PUBLIC domain is untouched — it is not PII, and hiding it would blind the
        // model to a link it may need to reason about.
        expect(out).toContain('https://docs.python.org/3/library');
      },
    );
  });

  it('a domain the warehouse does NOT know stays raw (known-only, not unconditional)', async () => {
    await withContact(
      (c) => c.upsertManual({ email: 'a@known.example', name: 'Ada Known' } as never, 2_000),
      async (plan) => {
        const { packet } = await egress(
          plan,
          priorPrompt({ call: memorySearchEntry('see https://unknown-vendor.example/pricing') }),
        );
        expect(firstOutputString(packet)).toBe('see https://unknown-vendor.example/pricing');
      },
    );
  });

  it('RESTORES a street line and a domain the model replies with (the hard invariant)', async () => {
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      contacts.upsertManual(ILANA, 2_000);
      const getIndex = createContactKnownValueIndexBuilder(() => contacts);
      const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);

      let seenByModel = '';
      const real: ExecuteChatAiCall = async (_m, input) => {
        seenByModel = String(input['llm.prompt']);
        return {
          body: {
            response: 'Visit pii.Address1 or https://d1.invalid/login',
            events: [],
            tool_calls: [],
          } satisfies AIOutput,
        };
      };
      const out = await wrapExecuteAiCallForPii(real, plan)(MANIFEST, {
        'llm.prompt': priorPrompt({
          call: memorySearchEntry('1600 Amphitheatre Parkway — https://northwind.example/login'),
        }),
      });

      expect(seenByModel).not.toContain('Amphitheatre');
      expect(seenByModel).not.toContain('northwind.example');
      expect((out.body as AIOutput).response).toBe(
        'Visit 1600 Amphitheatre Parkway or https://northwind.example/login',
      );
    } finally {
      db.close();
    }
  });
});

/** FAIL CLOSED when the shield cannot be built.
 *
 *  Every seed leg used to `catch` and silently drop its seeds, so a warehouse read error meant
 *  the recalled memory body went to the cloud LLM with every name / phone / street UNALIASED —
 *  and nothing failed, nothing logged. A leak indistinguishable from "nothing to alias".
 *
 *  ⚠ ABSENCE IS NOT FAILURE, and that distinction is the entire design. An EMPTY warehouse (or
 *  no store at all) is a COMPLETE shield over an empty set — it must still egress normally, or
 *  a brand-new server would withhold every recall forever. Only a THROWN read degrades. */
describe('recall egress — fail CLOSED on a degraded shield (absence is NOT failure)', () => {
  const throwingStore = (): ContactStore =>
    ({
      count: () => 1,
      listAllNamesAndCompanies: () => {
        throw new Error('warehouse read failed');
      },
      listRecallAddressSeeds: () => ({ streets: [], domains: [] }),
      resolveRecallIdentifiers: () => ({ emails: [], phones: [] }),
    }) as unknown as ContactStore;

  it('WITHHOLDS the recalled memory when a seed source THREW', async () => {
    const getIndex = createContactKnownValueIndexBuilder(() => throwingStore());
    expect(getIndex()!.isDegraded()).toBe(true);

    const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
    const { rawPrompt, packet } = await egress(
      plan,
      priorPrompt({
        call: memorySearchEntry('Ilana Vukovic can be reached on +14155550143'),
      }),
    );

    // The body never reaches the model — not aliased, WITHHELD.
    expect(rawPrompt).not.toContain('Ilana Vukovic');
    expect(rawPrompt).not.toContain('14155550143');
    expect(JSON.stringify(packet.recall_context)).toContain('withheld');
  });

  it('the withheld message says NOT-an-error and DO-NOT-RETRY (the anti-loop ratchet)', () => {
    // D-157 / D-177, learned the hard way: a result that reads as a silent failure makes a
    // reasoning model RETRY — qwen3.7-plus looped until the turn timed out. Do not weaken this.
    expect(RECALL_WITHHELD_MESSAGE).toMatch(/not an error/i);
    expect(RECALL_WITHHELD_MESSAGE).toMatch(/retry/i);
    expect(RECALL_WITHHELD_MESSAGE).toMatch(/tell the user/i);
  });

  it('an EMPTY warehouse is NOT degraded — it egresses normally (absence ≠ failure)', async () => {
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db); // zero contacts
      const getIndex = createContactKnownValueIndexBuilder(() => contacts);
      expect(getIndex()!.isDegraded()).toBe(false);

      const plan = withRecall(makePlan(piiEgress.noopFieldPrivacyResolver), getIndex);
      const { packet } = await egress(
        plan,
        priorPrompt({ call: memorySearchEntry('ping nobody@nowhere.com about it') }),
      );
      // Still shields what it can (the store-free email leg) — and does NOT withhold.
      expect(firstOutputString(packet)).toBe('ping m1@d1.invalid about it');
    } finally {
      db.close();
    }
  });

  it('NO contact store at all is NOT degraded either', () => {
    expect(createContactKnownValueIndexBuilder(() => undefined)()!.isDegraded()).toBe(false);
  });

  it('a THROWING CRM mirror also degrades (its people are unshielded and unknowable)', () => {
    const db = new Database(':memory:');
    try {
      const contacts = createContactStore(db);
      const getIndex = createContactKnownValueIndexBuilder(
        () => contacts,
        () =>
          ({
            listMetaRows: () => {
              throw new Error('mirror scan failed');
            },
          }) as unknown as CrmRecordMirrorStore,
      );
      expect(getIndex()!.isDegraded()).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('rolling brief carrying recall-derived content', () => {
  /** ⛔⛔ THE JOIN NEITHER SUITE COVERS. The recall suite above always drives a
   *  packet that CARRIES `recall_context`; the rolling-brief suite drives briefs
   *  with no PII wiring at all. The packet that leaks sits between them: a LATER
   *  turn that does no recall of its own, carrying a brief whose text holds a
   *  contact that only ever came from recall. Gate the whole-warehouse index on
   *  `hasRecallContext` alone and that name reaches the model RAW — the
   *  cross-session recall leak D-167 closes, reopened through the carry.
   *
   *  🔑 WHAT ACTUALLY HOLDS THE PROPERTY IS `hasPriorToolCalls`, NOT the recall
   *  branch: `briefAsPriorToolCall` ships the brief as a `context.brief` entry in
   *  `prior_tool_calls`, and `result` is a scanned data field. That is an
   *  INCIDENTAL join — nothing declares that the brief must ride a scanned field
   *  — so it is exactly the kind of property that regresses silently. Pin it. */
  const briefCall = (finding: string): Record<string, unknown> =>
    briefAsPriorToolCall({
      intent: 'total the charges',
      constraints: [],
      pending: [],
      findings: [finding],
      completed: [],
    }) as unknown as Record<string, unknown>;

  const planWith = (
    getContactKnownValueIndex: () => RecallResolver | undefined,
  ): PiiEgressPlan => {
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex,
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    return readPiiEgressPlan(state as Parameters<typeof readPiiEgressPlan>[0])!;
  };

  it('aliases a recalled contact carried in the brief when the packet has NO recall_context', async () => {
    const plan = planWith(() => recallResolver({ names: ['Diego Okafor'] }));

    const { rawPrompt, packet } = await egress(
      plan,
      priorPrompt({
        call: briefCall('The Diego Okafor retainer is 274 units.'),
        // ⚠ The user never types the name — if they had, the LEDGER scan would
        //   alias it and the test would pass without the recall index at all.
        user_message: 'add up the charges',
      }),
    );

    // The packet is the shape this test claims: a brief, and no recall field.
    expect(Array.isArray(packet['prior_tool_calls'])).toBe(true);
    expect(packet['recall_context']).toBeUndefined();
    // The contact never reached the model raw.
    expect(rawPrompt).not.toContain('Diego Okafor');
  });

  it('builds the whole-warehouse recall index for a brief-only packet', async () => {
    let builds = 0;
    const plan = planWith(() => {
      builds += 1;
      return recallResolver({ names: ['Diego Okafor'] });
    });

    await egress(
      plan,
      priorPrompt({
        call: briefCall('The Diego Okafor retainer is 274 units.'),
        user_message: 'add up the charges',
      }),
    );

    // Narrow the gate back to `hasRecallContext` and this is 0.
    expect(builds).toBe(1);
  });
});

describe('prior_tool_calls — args are a RECORD, not recall content', () => {
  /** ⛔⛔ ONE ENTITY MUST HAVE ONE SURFACE FORM. The whole `prior_tool_calls`
   *  array used to go through the recall pass, which runs
   *  `decorateOverlapReveal` on every string leaf — so the model's own echoed
   *  ARGUMENTS got a coreference tail.
   *
   *  🔑 MEASURED (bench 343, run z-343-r4): one packet, one contact, TWO forms —
   *  `user_message` + `prefetch_context` carried plain `pii.Person1` /
   *  `m1@d1.invalid`, `prior_tool_calls` carried `pii.Person1.dana.reyes` /
   *  `m1.dana.reyes@d1.invalid`. The model used the only email form it was ever
   *  shown; its echoed args returned in a form appearing NOWHERE in what it
   *  read. The grounding corpus excludes `prior_tool_calls` by design, so that
   *  identifier is unattributable: refused, re-sent, refused — 9 rounds to a
   *  timeout.
   *
   *  ⛔ AN EMAIL IS EXACT-MATCH. A tail is a harmless hint on a NAME; on an
   *  ADDRESS one extra character is a different address. The name alias already
   *  carries the coreference, so the email tail buys nothing and costs exactness.
   *
   *  `aliasRecallContextField` already draws this line for the identical shape;
   *  this pins the same rule for `prior_tool_calls`. */
  const withPriorCall = (args: unknown, result: unknown) => JSON.stringify({
    available_tools: [],
    commitment_context: [],
    chat_tail: [],
    // Discloses the NAME, which is what arms overlap-reveal at all.
    user_message: 'Dana Reyes asked me to audit the rings',
    prior_tool_calls: [{
      tool_name: 'memory.write', tier: 1, args, status: 'ok',
      result, started_at: 0, completed_at: 1,
    }],
  });

  it('does NOT put a coreference tail on an echoed tool-call ARG', async () => {
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex: () => recallResolver({
        names: ['Dana Reyes'], emails: ['dana.reyes@northwind.example'],
      }),
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    const plan = readPiiEgressPlan(state as Parameters<typeof readPiiEgressPlan>[0])!;

    const { rawPrompt } = await egress(plan, withPriorCall(
      { provenance_entity_ids: ['dana.reyes@northwind.example'] },
      { ok: true },
    ));
    const packet = JSON.parse(rawPrompt) as Record<string, unknown>;
    const argsOut = JSON.stringify(
      (packet['prior_tool_calls'] as Array<{ args: unknown }>)[0]!.args,
    );

    // The real address never egresses.
    expect(argsOut).not.toContain('northwind.example');
    // ⛔ THE PROPERTY: whatever alias form the arg takes, it carries NO
    //    disclosed-name tail. Restore the whole-array recall pass and the arg
    //    comes back as `m1.dana.reyes@d1.invalid` — a form the model never saw.
    expect(argsOut).not.toMatch(/m\d+\.[a-z.]*dana/i);
    expect(argsOut).not.toMatch(/pii\.Person\d+\.[a-z]/i);
  });

  it('keeps ONE surface form for the contact across packet fields', async () => {
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex: () => recallResolver({ names: ['Dana Reyes'] }),
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    const plan = readPiiEgressPlan(state as Parameters<typeof readPiiEgressPlan>[0])!;

    const { rawPrompt } = await egress(plan, withPriorCall(
      { note: 'Dana Reyes requested the audit' }, { ok: true },
    ));
    // A field-dependent surface form is the defect: the model cannot tell
    // "same contact rendered twice" from "two different contacts".
    const plain = (rawPrompt.match(/pii\.Person\d+(?![.\w])/g) ?? []).length;
    const tailed = (rawPrompt.match(/pii\.Person\d+\.[a-z]/gi) ?? []).length;
    expect({ tailed_forms_in_args_path: tailed > 0 && plain > 0 }).toEqual(
      { tailed_forms_in_args_path: false },
    );
  });
});


describe('the rolling brief packet is on the alias boundary', () => {
  /** ⛔⛔⛔ A REAL LEAK, SHIPPED, AND THIS FILE PREDICTED IT. The uniform scan is
   *  an ENUMERATION — its own note on `execution_precedent` says "a new
   *  model-bound field is silently absent from it and reaches the provider
   *  unaliased, WITH NOTHING FAILING." The rolling brief added four such fields
   *  (`user_request`, `carried_forward`, `tool_results_since`,
   *  `pending_user_statements`) and none were enumerated.
   *
   *  🔑 MEASURED 2026-09-09 over 2,865 outbound packets: 144 (5.0%) carried the
   *  seed contact's REAL NAME, and every one was a BRIEF packet —
   *  `carried_forward` 88, `user_request` 70, `tool_results_since` 43. The MAIN
   *  packet of the same turn carried `pii.Person1` and no raw name, so the
   *  ledger was live throughout: nothing was mis-aliased, the fields were simply
   *  never looked at.
   *
   *  ⚠ Aliasing is BEST-EFFORT by design ("aliasing may miss, restore may not"),
   *  so an unenumerated field does not fail — it silently egresses raw. That is
   *  exactly why this needs a test per field rather than one happy-path case. */
  const briefPacket = (field: string): string => JSON.stringify({
    available_tools: [],
    user_request: field === 'user_request' ? 'Dana Reyes asked for the audit' : 'x',
    carried_forward: field === 'carried_forward'
      ? { intent: 'audit', findings: ['Dana Reyes owns the rings'] } : null,
    tool_results_since: field === 'tool_results_since'
      ? [{ tool_name: 'work.read', result: { note: 'filed by Dana Reyes' } }] : [],
    pending_user_statements: field === 'pending_user_statements'
      ? ['Dana Reyes set the levy'] : [],
  });

  const planWithContact = () => {
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex: () => recallResolver({ names: ['Dana Reyes'] }),
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    return readPiiEgressPlan(state as Parameters<typeof readPiiEgressPlan>[0])!;
  };

  /** ⛔⛔⛔ THE PER-FIELD LOOP BELOW CANNOT CATCH THE FAILURE ITS OWN COMMENT
   *  DESCRIBES. Its field list is HAND-WRITTEN, so it tests exactly the fields
   *  someone remembered — while the harm is "a NEW model-bound field is
   *  silently absent from the enumeration and reaches the provider unaliased,
   *  WITH NOTHING FAILING". A list maintained by the same person who forgot the
   *  enumeration is not a guard against forgetting.
   *
   *  🔑 SO THIS ONE NAMES NO FIELDS: it fills every USER-ORIGINATED slot of a
   *  real fold packet with the contact's name and asserts the raw name egresses
   *  ZERO times. Add a user-text field and forget the enumeration, and this goes
   *  red without anyone having listed it.
   *
   *  ⛔⛔ TWO PACKET FIELDS ARE DELIBERATELY EXCLUDED, AND THE FIRST DRAFT OF
   *  THIS TEST WRONGLY FLAGGED BOTH — it asserted that EVERY field must be
   *  alias-scanned, which is false, and reported 2 leaks that were its own
   *  artifacts:
   *    · `recall_context` — not model-authored prose but the RECALL RESULTS,
   *      carried in their own typed shape and aliased by the recall path
   *      (`aliasEntityPayloadForEgress`), not the uniform scan. The draft
   *      invented a `{disclosedTexts}` shape production never sends, so it fell
   *      through unaliased and looked like a leak.
   *    · `prior_working_unverified` — the MODEL'S OWN planning text from a prior
   *      turn. The model only ever saw `pii.Person1`, so its output is already
   *      alias-form; this is the same reason `RecallScanContext` excludes
   *      assistant text, "it is aliased on egress … treating it as disclosed
   *      would over-reveal a fragment the user never typed".
   *  ⇒ the invariant is not "every field is scanned" but "every field carrying
   *  USER-ORIGINATED text is scanned". A field that can only hold model output
   *  needs no scan, and asserting otherwise manufactures false leaks. */
  it('no user-originated field of a full brief packet egresses the raw name', async () => {
    const NAME = 'Dana Reyes';
    const full = JSON.stringify({
      available_tools: [],
      user_request: `${NAME} asked for the audit`,
      carried_forward: {
        intent: `audit for ${NAME}`,
        constraints: [`${NAME} set the levy at 318`],
        findings: [`${NAME} owns the rings`],
        pending: [`ask ${NAME} about ring 09`],
        completed: [`read ${NAME}'s note`],
      },
      tool_results_since: [
        { tool_name: 'work.read', result: { note: `filed by ${NAME}` } },
      ],
      pending_user_statements: [`${NAME} set the levy`],
    });
    const plan = planWithContact();
    aliasIdentifierField(plan.ledger, 'name', NAME);
    const { rawPrompt } = await egress(plan, full);
    const leaked = rawPrompt.split(NAME).length - 1;
    expect(
      leaked,
      `raw contact name egressed ${String(leaked)}x — a user-originated field is `
      + 'missing from `uniformContentScanDataFields`',
    ).toBe(0);
  });

  for (const field of [
    'user_request', 'carried_forward', 'tool_results_since', 'pending_user_statements',
  ]) {
    it(`aliases the contact in \`${field}\``, async () => {
      const plan = planWithContact();
      // ⚠ SEED THE SESSION LEDGER FIRST, as production does. The brief call is
      //   never the turn's first packet — the MAIN packet has already aliased
      //   the contact (from the PREFETCH entity records, which arrive by wrapper
      //   closure and are not reachable from this helper). The content pass is
      //   LEDGER-ANCHORED, so with an empty ledger there is nothing to match and
      //   all four tests fail for a reason unrelated to the enumeration.
      aliasIdentifierField(plan.ledger, 'name', 'Dana Reyes');
      const { rawPrompt } = await egress(plan, briefPacket(field));
      // Drop the field from the enumeration and this goes red — silently, in
      // production, which is the whole point.
      expect(rawPrompt).not.toContain('Dana Reyes');
    });
  }
});


describe('RAW-VALUE RATCHET — no ledger value may egress unaliased', () => {
  /** ⛔⛔⛔ THE COMPLEMENT OF THE VOCABULARY CHECK, AND THE ONE THAT CATCHES A
   *  LEAK. `classifyAliasTokens` asks whether every alias token is one the
   *  ledger issued — that catches a rewritten surface form. A LEAK EMITS NO
   *  TOKEN AT ALL, so it is structurally blind to it. This asks the opposite.
   *
   *  🔑 It exists because the leak was live: the brief's four packet fields were
   *  absent from the egress enumeration and 144 of 2,865 corpus packets (5.0%)
   *  shipped the contact's real name. Aliasing is BEST-EFFORT ("aliasing may
   *  miss, restore may not"), so nothing threw, logged, or failed.
   *
   *  ⇒ DRIVES THE REAL `buildBriefPrompt` RATHER THAN A HAND-WRITTEN SHAPE. A
   *  test that lists today's fields only ever catches today's gap; the next
   *  field added to the builder would ship unaliased exactly as these four did.
   *  Building the packet with the production builder means a new PII-carrying
   *  field fails HERE, on the day it is added. */
  it('no ledger value survives a real brief packet', async () => {
    const state = new Map<string, unknown>();
    const middleware = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: piiEgress.noopFieldPrivacyResolver,
      getContactKnownValueIndex: () => recallResolver({ names: ['Dana Reyes'] }),
    });
    middleware.prompt?.({ session_id: 's', surface: 'chat', state } as never);
    const plan = readPiiEgressPlan(state as Parameters<typeof readPiiEgressPlan>[0])!;
    // The brief is never a turn's first packet — the main packet has already
    // aliased the contact into the session ledger from the prefetch records.
    aliasIdentifierField(plan.ledger, 'name', 'Dana Reyes');

    // PII in EVERY input the builder accepts, so no field is exercised by luck.
    const prompt = buildBriefPrompt({
      userMessage: 'Dana Reyes asked me to audit the rings',
      previous: {
        intent: 'audit for Dana Reyes',
        constraints: ['Dana Reyes set the levy at 318'],
        pending: ['report back to Dana Reyes'],
        findings: ['Dana Reyes owns the Kestrel rings'],
        completed: ['emailed Dana Reyes'],
      },
      since: [{
        tool_name: 'work.read', tier: 1, args: { q: 'Dana Reyes' },
        status: 'ok', result: { note: 'filed by Dana Reyes' },
        started_at: 0, completed_at: 1,
      }] as never,
      earlierUserMessages: ['Dana Reyes set the levy'],
    });

    const { rawPrompt } = await egress(plan, prompt);
    const leaked = rawLedgerValuesInText(plan.ledger, rawPrompt);
    expect({ leaked, raw: rawPrompt.includes('Dana Reyes') })
      .toEqual({ leaked: [], raw: false });
  });

  it('⛔ the detector actually fires — it is not vacuously empty', async () => {
    // The permitting witness. Without this, a detector that always returns []
    // would make the ratchet above pass forever.
    const l = piiEgress.createSessionLedgerStore().getOrCreate('s2');
    aliasIdentifierField(l, 'name', 'Dana Reyes');
    expect(rawLedgerValuesInText(l, 'a note from Dana Reyes today'))
      .toEqual(['Dana Reyes']);
    expect(rawLedgerValuesInText(l, 'a note from pii.Person1 today')).toEqual([]);
  });
});

it.each(['prior_tool_calls', 'tool_results_since'])('protects host evidence schema in %s through reharvest and degraded withholding', async lane => {
  const record = createMailWorkEvidence(null, 'Read the source.', true, 1);
  record.record({ tool_name: 'mail.read', tier: 1, args: { slug: 'work', record_id: 'source' }, status: 'ok', started_at: 1, completed_at: 2,
    result: { body: 'owner asked for an outline.', owner_private_key: 'owner' } });
  for (const tool_name of ['calendar.search', 'deal.search']) {
    record.record({ tool_name, tier: 1, args: { query: 'owner' }, status: 'ok', started_at: 1, completed_at: 2,
      result: { matches: [{ owner_private_key: 'owner' }] } });
  }
  const packet = { user_message: 'Continue.', [lane]: [record.asCall()], recall_context: [memorySearchEntry('A past conversation.')] };
  const plan: PiiEgressPlan = { ...withRecall(makePlan(() => []), () => recallResolver({ names: ['owner'] })),
    candidateReharvest: { contributor: { contribute: async () => ({ candidates: [{ kind: 'name', value: 'owner' }], partial: false,
      joined_source_session_ids: [], decrypted_rows: 0, decrypted_bytes: 0 }) }, getJoinedPieces: () => [], hasRegisteredRecall: () => true } };
  const protectedPacket = (await egress(plan, JSON.stringify(packet))).packet;
  const result = (protectedPacket[lane] as Array<{ result: Record<string, any> }>)[0]!.result;
  expect(result.owner_updates).toEqual([]);
  expect(result.owner_updates_before_request).toBe(0);
  expect(result.note).toContain('entries in owner_updates');
  expect(JSON.stringify(result.observations)).not.toContain('owner_private_key');
  expect(JSON.stringify(result.observations)).toContain('pii.Person');
  const withheld = await egress({ ...makePlan(() => []), recall: { getIndex: () => ({ ...recallResolver({ names: ['owner'] }), isDegraded: () => true }) } }, JSON.stringify(packet));
  expect((withheld.packet[lane] as Array<{ result: unknown }>)[0]!.result).toBe(RECALL_WITHHELD_MESSAGE);
  expect(withheld.rawPrompt).not.toContain('asked for an outline');
});
