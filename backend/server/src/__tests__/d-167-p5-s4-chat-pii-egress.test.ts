/** D-167 P5 S4 — chat-mode PII egress bookend hooks + wire-seam enactment.
 *
 *  S4 registers the always-on `pii-protect` (first `prompt`) / `pii-restore`
 *  (last `update`) bookends into `createChatStreamMiddlewares` and wraps the
 *  orchestrator's `executeAiCall` so every outbound packet is aliased + every
 *  returned body restored (N.9 ENACT). These tests pin:
 *    - the ratchet-pinned bookend ORDER (pii-protect first, pii-restore last);
 *    - `pii-protect`'s plan DECISION (gate by surface, policy resolution,
 *      ledger get-or-create);
 *    - the wrap seam's alias-out / restore-in + `cloud_egress_opt_out`
 *      local-only enforcement + fail-open + summary accumulation;
 *    - `pii-restore`'s total-restore backstop;
 *    - end-to-end through the real orchestrator: behavior-preserving with the
 *      noop resolver, and alias→restore→audit-summary with a stub resolver;
 *    - the session-delete ledger purge.
 */

import Database from 'better-sqlite3';
import { piiEgress } from '@recued/gateway';
import {
  type AIOutput,
  type IngredientManifest,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import type { TurnContext, TurnResult } from '@recued/middleware';
import { describe, expect, it, vi } from 'vitest';

import {
  CHAT_PII_EGRESS_PLAN_STATE_KEY,
  CHAT_PII_RESTORED_TEXT_STATE_KEY,
  PII_PROTECT_MIDDLEWARE_ID,
  PII_RESTORE_MIDDLEWARE_ID,
  createPiiProtectMiddleware,
  createPiiRestoreMiddleware,
  readPiiEgressPlan,
  readPiiRedactionSummary,
  readPiiRestoredText,
  wrapExecuteAiCallForPii,
  type PiiEgressHookDeps,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import { createChatStreamMiddlewares } from '../chat-stream-middleware.js';
import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { handleSessionDelete, type ChatRpcDeps } from '../chat-handler.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const MANIFEST = {} as IngredientManifest;

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const internalRegistry = (): InternalToolRegistry => ({
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
  subscribeRefresh: () => () => undefined,
});

/** A fresh single-session ledger store + its one ledger. */
const freshLedger = () => {
  const store = piiEgress.createSessionLedgerStore();
  return { store, ledger: store.getOrCreate('s') };
};

/** A `PiiEgressPlan` with sensible defaults — comfort, active, noop resolver,
 *  a fresh ledger — overridable per test. */
const makePlan = (over: Partial<PiiEgressPlan> = {}): PiiEgressPlan => ({
  active: true,
  ledger: freshLedger().ledger,
  resolver: piiEgress.noopFieldPrivacyResolver,
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
  restoreAuthority: {},
  restoredAssistantText: {},
  ...over,
});

/** A minimal `TurnContext` carrying only the fields the `prompt` hook reads. */
const promptCtx = (
  state: Map<string, unknown>,
  surface: TurnContext['surface'] = 'chat',
  session_id = 'sess-1',
): TurnContext =>
  ({ session_id, surface, state } as unknown as TurnContext);

/** A minimal `TurnResult` carrying only the fields the `update` hook reads. */
const updateCtx = (
  state: Map<string, unknown>,
  text: string,
): TurnResult =>
  ({ state, output: { text } } as unknown as TurnResult);

// A stub resolver that tags the packet's `user_message` as an email
// identifier — drives a real alias allocation (`m1@d1.invalid`).
const userMessageEmailResolver: piiEgress.FieldPrivacyResolver = () => [
  { path: 'user_message', kind: 'email' },
];

const priorToolContactResolver: piiEgress.FieldPrivacyResolver = (packet) => {
  const p = packet as Record<string, unknown>;
  return Array.isArray(p.prior_tool_calls)
    ? [
        { path: 'prior_tool_calls.0.result.email', kind: 'email' },
        { path: 'prior_tool_calls.0.result.fullName', kind: 'name' },
      ]
    : [];
};

const freeTextUserMessageEmailResolver: piiEgress.FieldPrivacyResolver = (packet) => [
  { path: 'user_message', kind: 'email' },
  ...priorToolContactResolver(packet),
];

// Tags a present `owner` field as a name — drives a real-name alias allocation
// (`pii.Person<N>`) so a Slice 3 test can collide it with a typed literal.
const ownerNameResolver: piiEgress.FieldPrivacyResolver = (packet) => {
  const p = packet as Record<string, unknown>;
  return typeof p.owner === 'string' ? [{ path: 'owner', kind: 'name' }] : [];
};

describe('D-167 P5 S4 — createChatStreamMiddlewares bookend order', () => {
  const pii: PiiEgressHookDeps = { ledgerStore: piiEgress.createSessionLedgerStore() };
  const baseDeps = { now: () => NOW, resolveTzClock: () => null };

  it('pins pii-protect FIRST and pii-restore LAST around the source adapters', () => {
    const mws = createChatStreamMiddlewares({
      registry: {
        enabled: () => [],
        register: () => {},
        disable: () => {},
        enable: () => {},
      } as never,
      pii,
      ...baseDeps,
    });
    expect(mws.map((m) => m.id)).toEqual([
      PII_PROTECT_MIDDLEWARE_ID,
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
      'prompt-cache',
      PII_RESTORE_MIDDLEWARE_ID,
    ]);
  });

  it('builds the PII bookends even with NO registry (always-on)', () => {
    const mws = createChatStreamMiddlewares({ pii, ...baseDeps });
    expect(mws.map((m) => m.id)).toEqual([
      PII_PROTECT_MIDDLEWARE_ID,
      PII_RESTORE_MIDDLEWARE_ID,
    ]);
  });

  it('omits the PII bookends when no PII deps are wired', () => {
    const mws = createChatStreamMiddlewares({
      registry: {
        enabled: () => [],
        register: () => {},
        disable: () => {},
        enable: () => {},
      } as never,
      ...baseDeps,
    });
    expect(mws.map((m) => m.id)).toEqual([
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
      'prompt-cache',
    ]);
  });

  it('yields an empty list when neither registry nor PII is wired', () => {
    expect(createChatStreamMiddlewares({ ...baseDeps })).toEqual([]);
  });

  it('pii-protect is a prompt-only hook; pii-restore is an update-only hook', () => {
    const mws = createChatStreamMiddlewares({ pii, ...baseDeps });
    const protect = mws.find((m) => m.id === PII_PROTECT_MIDDLEWARE_ID)!;
    const restore = mws.find((m) => m.id === PII_RESTORE_MIDDLEWARE_ID)!;
    expect(typeof protect.prompt).toBe('function');
    expect(protect.update).toBeUndefined();
    expect(typeof restore.update).toBe('function');
    expect(restore.prompt).toBeUndefined();
  });
});

describe('D-167 P5 S4 — pii-protect prompt hook (DECIDE → state)', () => {
  it('writes an active plan on the chat surface', () => {
    const ledgerStore = piiEgress.createSessionLedgerStore();
    const mw = createPiiProtectMiddleware({ ledgerStore });
    const state = new Map<string, unknown>();
    mw.prompt!(promptCtx(state, 'chat'));
    const plan = readPiiEgressPlan(state);
    expect(plan?.active).toBe(true);
    expect(plan?.resolver).toBe(piiEgress.noopFieldPrivacyResolver);
    // The ledger is the session's ledger from the store (get-or-create).
    expect(plan?.ledger).toBe(ledgerStore.get('sess-1'));
  });

  it('writes an INACTIVE plan on an external-egress (messenger) surface', () => {
    const mw = createPiiProtectMiddleware({
      ledgerStore: piiEgress.createSessionLedgerStore(),
    });
    const state = new Map<string, unknown>();
    mw.prompt!(promptCtx(state, 'messenger-slack'));
    expect(readPiiEgressPlan(state)?.active).toBe(false);
  });
});

describe('D-167 P5 S4 — wrapExecuteAiCallForPii (ENACT)', () => {
  it('returns the real executor unchanged for an inactive plan', () => {
    const real: ExecuteChatAiCall = async () => ({ body: {} });
    expect(wrapExecuteAiCallForPii(real, makePlan({ active: false }))).toBe(real);
  });

  it('round-trips the prompt unchanged with the noop resolver (behavior-preserving)', async () => {
    const plan = makePlan(); // noop resolver
    const original = JSON.stringify({
      available_tools: [],
      commitment_context: [],
      chat_tail: [{ role: 'user', content: 'hi alice@acme.com' }],
      user_message: 'ping',
    });
    let seen = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      seen = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    const result = await wrapped(MANIFEST, { 'llm.prompt': original, 'llm.system_prompt': 'sys' });
    expect(seen).toBe(original); // nothing aliased → byte-identical egress
    expect((result.body as AIOutput).response).toBe('ok'); // body untouched
    expect(readPiiRedactionSummary(plan)).toBeUndefined(); // zero counts
  });

  it('returns the prompt byte-identical with the noop resolver even with prototype-unsafe keys', async () => {
    // A tool result can legitimately carry a key named `constructor` /
    // `__proto__`. The alias pass deep-clones (stripping those keys), so the
    // noop path must short-circuit and NOT touch the packet. Raw JSON literal
    // (object literals would set the prototype, not an own key).
    const original =
      '{"user_message":"hi","prior_tool_calls":[{"result":{"constructor":"x","__proto__":"y","safe":1}}]}';
    let seen = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      seen = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    await wrapExecuteAiCallForPii(real, makePlan())(MANIFEST, { 'llm.prompt': original });
    expect(seen).toBe(original);
  });

  it('Slice 3 — a reserve-only packet (typed pii.* literal, no real alias) stays byte-identical incl. prototype-unsafe keys', async () => {
    // A typed `pii.Person1` literal RESERVES a slot (writes byKindBaseAlias) but
    // seeds NO real value to scan for. The content-scan gates key on
    // byKindRealValue, so this packet must still short-circuit on the byte-identity
    // fast path — NOT deep-clone (which would drop the own `constructor` key).
    const original =
      '{"user_message":"call pii.Person1","prior_tool_calls":[{"args":{"constructor":"x","safe":1}}]}';
    let seen = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      seen = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    await wrapExecuteAiCallForPii(real, makePlan())(MANIFEST, { 'llm.prompt': original });
    expect(seen).toBe(original);
  });

  it('aliases the outbound packet and restores the returned body (stub resolver)', async () => {
    const plan = makePlan({ resolver: userMessageEmailResolver });
    let seenPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_m, input) => {
      seenPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      // The model echoes the alias it saw.
      return {
        body: {
          response: `I will contact ${seenPacket.user_message}`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    const result = await wrapped(MANIFEST, {
      'llm.prompt': JSON.stringify({ user_message: 'alice@acme.com', chat_tail: [] }),
      'llm.system_prompt': 'sys',
    });
    // Egress: the real email never reached the (cloud) executor.
    expect(seenPacket.user_message).not.toBe('alice@acme.com');
    expect(String(seenPacket.user_message)).toMatch(/^m\d+@d\d+\.invalid$/);
    // Return: the alias the model echoed is restored to the real value.
    expect((result.body as AIOutput).response).toBe('I will contact alice@acme.com');
    // Audit: the redaction summary counted the email.
    expect(readPiiRedactionSummary(plan)?.counts.email).toBe(1);
  });

  it('Slice 3 — a user-typed pii.Person1 literal is reserved while the real name aliases past it (no collision)', async () => {
    const plan = makePlan({ resolver: ownerNameResolver });
    let seenPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_m, input) => {
      seenPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      // The model echoes BOTH the real-name alias and the user's typed literal.
      return {
        body: {
          response: `${String(seenPacket.owner)} re ${String(seenPacket.user_message)}`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    const result = await wrapped(MANIFEST, {
      // The note both NAMES a real person (owner) AND contains the literal token
      // "pii.Person1" (the user anonymizing a different friend).
      'llm.prompt': JSON.stringify({
        owner: 'Pat Lee',
        user_message: 'also ping pii.Person1',
        chat_tail: [],
      }),
    });
    // Egress: the literal claimed pii.Person1, so the real name aliased PAST it to
    // pii.Person2; the literal reached the model unchanged.
    expect(seenPacket.owner).toBe('pii.Person2');
    expect(seenPacket.user_message).toBe('also ping pii.Person1');
    // Restore: the real name comes back AND the literal round-trips to itself —
    // pre-Slice-3 the literal would have un-aliased into "Pat Lee".
    expect((result.body as AIOutput).response).toBe('Pat Lee re also ping pii.Person1');
  });

  it('content-scans user_message against resolver-seeded ledger anchors', async () => {
    const plan = makePlan({ resolver: priorToolContactResolver });
    let seenPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_m, input) => {
      seenPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      return {
        body: {
          response: `noted ${String(seenPacket.user_message)}`,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    const result = await wrapped(MANIFEST, {
      'llm.prompt': JSON.stringify({
        user_message: 'ask Alice Ada at alice@acme.com',
        prior_tool_calls: [
          {
            tool_name: 'recued-core/hubspot.contact.read',
            status: 'ok',
            result: { email: 'alice@acme.com', fullName: 'Alice Ada' },
          },
        ],
      }),
    });

    const prior = (seenPacket.prior_tool_calls as Array<{
      result?: { email?: string; fullName?: string };
    }>)[0]?.result;
    expect(prior?.email).toBe('m1@d1.invalid');
    expect(prior?.fullName).toBe('pii.Person1');
    expect(seenPacket.user_message).toBe('ask pii.Person1 at m1@d1.invalid');
    expect((result.body as AIOutput).response).toBe(
      'noted ask Alice Ada at alice@acme.com',
    );
    expect(readPiiRedactionSummary(plan)?.counts).toEqual({
      email: 1,
      name: 1,
      content_text_replacements: 2,
    });
  });

  it('treats tagged free-text user_message as content, not one malformed identifier', async () => {
    const plan = makePlan({ resolver: freeTextUserMessageEmailResolver });
    let seenPacket: Record<string, unknown> = {};
    const real: ExecuteChatAiCall = async (_m, input) => {
      seenPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    await wrapped(MANIFEST, {
      'llm.prompt': JSON.stringify({
        user_message: 'contact alice@acme.com',
        prior_tool_calls: [
          {
            tool_name: 'recued-core/hubspot.contact.read',
            status: 'ok',
            result: { email: 'alice@acme.com', fullName: 'Alice Ada' },
          },
        ],
      }),
    });

    expect(seenPacket.user_message).toBe('contact m1@d1.invalid');
    expect(String(seenPacket.user_message)).not.toMatch(/^m\d+@d\d+\.invalid$/);
    expect(String(seenPacket.user_message)).not.toContain('alice@acme.com');
    expect(readPiiRedactionSummary(plan)?.counts).toEqual({
      email: 1,
      name: 1,
      content_text_replacements: 1,
    });
  });

  it('fails open on a non-JSON prompt (passes it through raw)', async () => {
    const plan = makePlan({ resolver: userMessageEmailResolver });
    let seen = '';
    const real: ExecuteChatAiCall = async (_m, input) => {
      seen = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    await wrapped(MANIFEST, { 'llm.prompt': 'not json {{{' });
    expect(seen).toBe('not json {{{');
  });

  it('P3 leaves a guessed session alias raw when this request did not show it', async () => {
    const plan = makePlan();
    const seeded = piiEgress.aliasPacketForEgress({
      ledger: plan.ledger,
      packet: { email: 'alice@acme.com' },
      resolver: () => [{ path: 'email', kind: 'email' }],
    });
    const guessed = (seeded.aliased as { email: string }).email;
    const real: ExecuteChatAiCall = async () => ({
      body: {
        response: `guessed ${guessed}`,
        events: [],
        tool_calls: [{ tool: 'mail.send', args: { to: guessed } }],
      } satisfies AIOutput,
    });

    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      { 'llm.prompt': JSON.stringify({ user_message: 'hello' }) },
    );
    expect((result.body as AIOutput).response).toBe(`guessed ${guessed}`);
    expect((result.body as AIOutput).tool_calls[0]?.args).toEqual({ to: guessed });
  });

  it('P3 admits an alias shown inside a key-aware identifier key', () => {
    const ledger = freshLedger().ledger;
    const seeded = piiEgress.aliasPacketForEgress({
      ledger,
      packet: { owner: 'Alice Ada' },
      resolver: () => [{ path: 'owner', kind: 'name' }],
    });
    const alias = (seeded.aliased as { owner: string }).owner;
    const exposedKey = `owner_${alias}`;
    const authority = piiEgress.deriveRequestRestoreAuthority(
      ledger,
      JSON.stringify({ [exposedKey]: true }),
    );
    expect(
      piiEgress.restoreArgsAndKeysForApprovalWithAuthority(
        authority,
        { [exposedKey]: true },
      ),
    ).toEqual({ 'owner_Alice Ada': true });
  });

  it('P3 escapes a literal alias-shaped request key before granting key-aware restore authority', async () => {
    const plan = makePlan({ resolver: ownerNameResolver });
    expect(
      (piiEgress.aliasPacketForEgress({
        ledger: plan.ledger,
        packet: { owner: 'Pat Lee' },
        resolver: () => [{ path: 'owner', kind: 'name' }],
      }).aliased as { owner: string }).owner,
    ).toBe('pii.Person1');

    let exposedKey = '';
    let exposedOwner = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as Record<
        string,
        unknown
      >;
      exposedKey = Object.keys(packet).find(
        (key) => key.startsWith('pii.Person'),
      ) ?? '';
      exposedOwner = String(packet.owner);
      return {
        body: {
          response: `literal ${exposedKey}`,
          events: [],
          tool_calls: [{ tool: 'noop', args: { copied: exposedKey } }],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          owner: 'Pat Lee',
          user_message: 'hello',
          'pii.Person1': 'literal data',
        }),
      },
    );
    expect(exposedKey).toBe('pii.Person2');
    // Both mappings are request-authorized. Key restoration must still be one
    // pass so Person2 -> literal Person1 does not cascade into Pat Lee.
    expect(exposedOwner).toBe('pii.Person1');
    expect((result.body as AIOutput).response).toBe('literal pii.Person1');
    expect((result.body as AIOutput).tool_calls[0]?.args).toEqual({
      copied: 'pii.Person1',
    });
    expect((result.body as AIOutput).response).not.toContain('Pat Lee');
  });

  it('P3 escapes a literal alias embedded after a request-key separator', async () => {
    const plan = makePlan({ resolver: ownerNameResolver });
    expect(
      (piiEgress.aliasPacketForEgress({
        ledger: plan.ledger,
        packet: { owner: 'Pat Lee' },
        resolver: () => [{ path: 'owner', kind: 'name' }],
      }).aliased as { owner: string }).owner,
    ).toBe('pii.Person1');

    let exposedKey = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as Record<
        string,
        unknown
      >;
      exposedKey = Object.keys(packet).find(
        (key) => key.startsWith('owner_pii.Person'),
      ) ?? '';
      return {
        body: {
          response: exposedKey,
          events: [],
          tool_calls: [{ tool: 'noop', args: { [exposedKey]: true } }],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          owner: 'Pat Lee',
          user_message: 'hello',
          'owner_pii.Person1': 'literal data',
        }),
      },
    );
    expect(exposedKey).toBe('owner_pii.Person2');
    expect((result.body as AIOutput).response).toBe('owner_pii.Person1');
    expect((result.body as AIOutput).tool_calls[0]?.args).toEqual({
      'owner_pii.Person1': true,
    });
    expect(JSON.stringify(result.body)).not.toContain('Pat Lee');
  });

  it('P3 escapes a colliding literal email alias before request authority is derived', async () => {
    const plan = makePlan({ resolver: userMessageEmailResolver });
    expect(
      (piiEgress.aliasPacketForEgress({
        ledger: plan.ledger,
        packet: { user_message: 'alice@acme.com' },
        resolver: userMessageEmailResolver,
      }).aliased as { user_message: string }).user_message,
    ).toBe('m1@d1.invalid');

    let exposed = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as {
        user_message: string;
      };
      exposed = packet.user_message;
      return {
        body: {
          response: exposed,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    };

    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      {
        'llm.prompt': JSON.stringify({
          user_message: 'm1@d1.invalid',
        }),
      },
    );
    expect(exposed).toBe('m2@d2.invalid');
    expect((result.body as AIOutput).response).toBe('m1@d1.invalid');
    expect((result.body as AIOutput).response).not.toBe('alice@acme.com');
  });

  it('discards staged mappings and capture authority when the provider fails', async () => {
    const plan = makePlan({ resolver: userMessageEmailResolver });
    let captured = 0;
    const real: ExecuteChatAiCall = async () => {
      throw new Error('provider unavailable');
    };
    const wrapped = wrapExecuteAiCallForPii(
      real,
      plan,
      () => {
        captured += 1;
      },
    );

    await expect(
      wrapped(
        MANIFEST,
        { 'llm.prompt': JSON.stringify({ user_message: 'alice@acme.com' }) },
      ),
    ).rejects.toThrow('provider unavailable');
    expect(plan.ledger.byKindRealValue.size).toBe(0);
    expect(plan.ledger.byKindBaseAlias.size).toBe(0);
    expect(plan.restoreAuthority?.value).toBeUndefined();
    expect(captured).toBe(0);
  });

  it('serializes overlapping requests on one ledger so aliases cannot collide at commit', async () => {
    const plan = makePlan({
      resolver: () => [{
        path: 'prior_tool_calls.0.result.name',
        kind: 'name',
      }],
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const providerPackets: Record<string, unknown>[] = [];
    const real = vi.fn<ExecuteChatAiCall>(async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt'])) as Record<
        string,
        unknown
      >;
      providerPackets.push(packet);
      if (providerPackets.length === 1) await firstGate;
      const name = (
        packet.prior_tool_calls as Array<{ result: { name: string } }>
      )[0]!.result.name;
      return {
        body: {
          response: name,
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    });
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    const first = wrapped(MANIFEST, {
      'llm.prompt': JSON.stringify({
        prior_tool_calls: [{ result: { name: 'Alice Ada' } }],
      }),
    });
    await vi.waitFor(() => expect(real).toHaveBeenCalledTimes(1));
    const second = wrapped(MANIFEST, {
      'llm.prompt': JSON.stringify({
        prior_tool_calls: [{ result: { name: 'Bob Baker' } }],
      }),
    });
    await Promise.resolve();
    expect(real).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({
      body: { response: 'Alice Ada' },
    });
    await expect(second).resolves.toMatchObject({
      body: { response: 'Bob Baker' },
    });
    expect(providerPackets.map((packet) => (
      packet.prior_tool_calls as Array<{ result: { name: string } }>
    )[0]!.result.name)).toEqual(['pii.Person1', 'pii.Person2']);
    expect(plan.ledger.byKindRealValue.get('name::Alice Ada')?.alias_value).toBe(
      'pii.Person1',
    );
    expect(plan.ledger.byKindRealValue.get('name::Bob Baker')?.alias_value).toBe(
      'pii.Person2',
    );
  });

  it('accumulates the redaction summary across multiple egress packets', async () => {
    const plan = makePlan({ resolver: userMessageEmailResolver });
    const real: ExecuteChatAiCall = async (_m, input) => ({
      body: {
        response: String(
          (JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>).user_message,
        ),
        events: [],
        tool_calls: [],
      } satisfies AIOutput,
    });
    const wrapped = wrapExecuteAiCallForPii(real, plan);
    // Two distinct emails → two allocations → summary email count 2.
    await wrapped(MANIFEST, { 'llm.prompt': JSON.stringify({ user_message: 'a@x.com' }) });
    await wrapped(MANIFEST, { 'llm.prompt': JSON.stringify({ user_message: 'b@y.com' }) });
    expect(readPiiRedactionSummary(plan)?.counts.email).toBe(2);
  });
});

describe('D-167 P5 S4 — pii-restore update hook (total-restore backstop)', () => {
  it('no-ops when no plan is present (PII unwired)', () => {
    const mw = createPiiRestoreMiddleware();
    const state = new Map<string, unknown>();
    mw.update!(updateCtx(state, 'hello'));
    expect(readPiiRestoredText(state)).toBeUndefined();
  });

  it('no-ops on an inactive plan', () => {
    const mw = createPiiRestoreMiddleware();
    const state = new Map<string, unknown>();
    state.set(CHAT_PII_EGRESS_PLAN_STATE_KEY, makePlan({ active: false }));
    mw.update!(updateCtx(state, 'hello'));
    expect(readPiiRestoredText(state)).toBeUndefined();
  });

  it('writes the assistant text unchanged when nothing aliased (empty ledger)', () => {
    const mw = createPiiRestoreMiddleware();
    const state = new Map<string, unknown>();
    state.set(CHAT_PII_EGRESS_PLAN_STATE_KEY, makePlan());
    mw.update!(updateCtx(state, 'plain reply'));
    expect(readPiiRestoredText(state)).toBe('plain reply');
  });

  it('restores only an alias present in the successful request authority', () => {
    const { ledger } = freshLedger();
    // Populate the ledger by aliasing an email.
    const { aliased } = piiEgress.aliasPacketForEgress({
      ledger,
      packet: { email: 'alice@acme.com' },
      resolver: () => [{ path: 'email', kind: 'email' }],
    });
    const alias = (aliased as { email: string }).email;
    const restoreAuthority = {
      value: piiEgress.deriveRequestRestoreAuthority(
        ledger,
        JSON.stringify({ email: alias }),
      ),
    };
    const mw = createPiiRestoreMiddleware();
    const state = new Map<string, unknown>();
    state.set(
      CHAT_PII_EGRESS_PLAN_STATE_KEY,
      makePlan({ ledger, restoreAuthority }),
    );
    mw.update!(updateCtx(state, `reply about ${alias}`));
    expect(readPiiRestoredText(state)).toBe('reply about alice@acme.com');
  });

  it('does not restore a session alias absent from the request authority', () => {
    const { ledger } = freshLedger();
    const { aliased } = piiEgress.aliasPacketForEgress({
      ledger,
      packet: { email: 'alice@acme.com' },
      resolver: () => [{ path: 'email', kind: 'email' }],
    });
    const alias = (aliased as { email: string }).email;
    const restoreAuthority = {
      value: piiEgress.deriveRequestRestoreAuthority(
        ledger,
        JSON.stringify({ user_message: 'nothing sensitive' }),
      ),
    };
    const mw = createPiiRestoreMiddleware();
    const state = new Map<string, unknown>();
    state.set(
      CHAT_PII_EGRESS_PLAN_STATE_KEY,
      makePlan({ ledger, restoreAuthority }),
    );
    mw.update!(updateCtx(state, `guessed ${alias}`));
    expect(readPiiRestoredText(state)).toBe(`guessed ${alias}`);
  });

  it('does not second-pass an escaped alias literal already restored by the wire seam', () => {
    const { ledger } = freshLedger();
    expect(
      (piiEgress.aliasPacketForEgress({
        ledger,
        packet: { owner: 'Pat Lee' },
        resolver: () => [{ path: 'owner', kind: 'name' }],
      }).aliased as { owner: string }).owner,
    ).toBe('pii.Person1');
    const escaped = piiEgress.preScanPacketForEgress(
      ledger,
      'pii.Person1',
    ).value;
    expect(escaped).toBe('pii.Person2');
    const authority = piiEgress.deriveRequestRestoreAuthority(
      ledger,
      JSON.stringify({ owner: 'pii.Person1', literal: escaped }),
    );
    const alreadyRestored = piiEgress.restoreForDisplayWithAuthority(
      authority,
      String(escaped),
    );
    expect(alreadyRestored).toBe('pii.Person1');

    const plan = makePlan({
      ledger,
      restoreAuthority: { value: authority },
      restoredAssistantText: { value: alreadyRestored },
    });
    const state = new Map<string, unknown>([
      [CHAT_PII_EGRESS_PLAN_STATE_KEY, plan],
    ]);
    createPiiRestoreMiddleware().update!(
      updateCtx(state, alreadyRestored),
    );
    expect(readPiiRestoredText(state)).toBe('pii.Person1');
    expect(readPiiRestoredText(state)).not.toBe('Pat Lee');
  });
});

describe('D-167 P5 S4 — readers', () => {
  it('readPiiEgressPlan returns undefined for absent / malformed state', () => {
    expect(readPiiEgressPlan(new Map())).toBeUndefined();
    const bad = new Map<string, unknown>([[CHAT_PII_EGRESS_PLAN_STATE_KEY, { active: 'yes' }]]);
    expect(readPiiEgressPlan(bad)).toBeUndefined();
  });

  it('readPiiEgressPlan rejects a plan with malformed nested shapes (fail open)', () => {
    const badLedger = new Map<string, unknown>([
      [
        CHAT_PII_EGRESS_PLAN_STATE_KEY,
        {
          active: true,
          resolver: () => [],
          ledger: { byKindBaseAlias: {} }, // not a Map
          summary: { value: {} },
        },
      ],
    ]);
    expect(readPiiEgressPlan(badLedger)).toBeUndefined();
    const badSummary = new Map<string, unknown>([
      [
        CHAT_PII_EGRESS_PLAN_STATE_KEY,
        {
          active: true,
          resolver: () => [],
          ledger: { byKindBaseAlias: new Map() },
          summary: { value: 'nope' }, // not an object
        },
      ],
    ]);
    expect(readPiiEgressPlan(badSummary)).toBeUndefined();
  });

  it('readPiiRestoredText returns undefined when absent / non-string', () => {
    expect(readPiiRestoredText(new Map())).toBeUndefined();
    expect(
      readPiiRestoredText(new Map([[CHAT_PII_RESTORED_TEXT_STATE_KEY, 42]])),
    ).toBeUndefined();
  });

  it('readPiiRedactionSummary omits an all-zero summary, returns a non-zero one', () => {
    expect(readPiiRedactionSummary(undefined)).toBeUndefined();
    expect(readPiiRedactionSummary(makePlan())).toBeUndefined();
    const plan = makePlan();
    plan.summary.value = { mode: 'alias', scope_kind: 'session', counts: { email: 2 } };
    expect(readPiiRedactionSummary(plan)?.counts.email).toBe(2);
  });

  it('readPiiRedactionSummary fails open (no throw) on a malformed summary missing counts', () => {
    const plan = makePlan();
    (plan.summary as { value: unknown }).value = {}; // object but no `counts`
    expect(readPiiRedactionSummary(plan)).toBeUndefined();
  });
});

// ── End-to-end through the real orchestrator ───────────────────────────────

interface E2EResult {
  readonly egressPacket: Record<string, unknown>;
  readonly messageComplete: string | undefined;
  readonly tokenStreamed: string | undefined;
  readonly assistantAudit: Record<string, unknown> | undefined;
  readonly sourceLifecycles: readonly string[];
}

const runOrchestratorTurn = async (opts: {
  resolver?: piiEgress.FieldPrivacyResolver;
  userMessage?: string;
  modelProvider?: string;
  modelLayer?: 'free_pool' | 'byok';
  aiResponse?: (egress: Record<string, unknown>) => string;
}): Promise<E2EResult> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });
    if (opts.modelProvider || opts.modelLayer) {
      chatStore.setModelPref(
        'sess-1',
        { current: opts.modelLayer ?? 'byok', ...(opts.modelProvider ? { provider: opts.modelProvider } : {}) },
        NOW,
      );
    }
    const broadcasts: Array<Record<string, unknown>> = [];
    const auditRows: Array<{ action: string; detail?: string }> = [];
    const ledgerStore = piiEgress.createSessionLedgerStore();
    let egressPacket: Record<string, unknown> = {};
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_m, input) => {
      egressPacket = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
      return {
        body: {
          response: opts.aiResponse ? opts.aiResponse(egressPacket) : 'plain reply',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    });
    let idSeq = 0;
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: internalRegistry(),
      broadcast: { emit: (e) => broadcasts.push(e as Record<string, unknown>) },
      auditLog: {
        logActivity: vi.fn(async (entry: { action: string; detail?: string }) => {
          auditRows.push({ action: entry.action, detail: entry.detail });
        }),
      } as never,
      selfSignature,
      executeAiCall,
      piiLedgerStore: ledgerStore,
      ...(opts.resolver ? { fieldPrivacyResolver: opts.resolver } : {}),
      now: () => NOW,
      mintId: () => `id-${++idSeq}`,
    });

    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: opts.userMessage ?? 'please help',
      picker_state: { current: 'self' },
      ...(opts.modelLayer ? { model_pref: { current: opts.modelLayer } } : {}),
    });

    const messageComplete = broadcasts.find((b) => b.kind === 'chat.message_complete');
    const tokenStreamed = broadcasts.find((b) => b.kind === 'chat.token_streamed');
    const assistantAudit = auditRows
      .filter((r) => r.action === 'chat_message_sent')
      .map((r) => JSON.parse(r.detail ?? '{}') as Record<string, unknown>)
      .find((d) => d.role === 'assistant');
    const sourceLifecycles = (
      db.prepare(`
        SELECT source_lifecycle
          FROM chat_messages
         ORDER BY ts ASC, message_id ASC
      `).all() as Array<{ source_lifecycle: string }>
    ).map((row) => row.source_lifecycle);
    return {
      egressPacket,
      messageComplete: (messageComplete?.final as { content?: string } | undefined)?.content,
      tokenStreamed: tokenStreamed?.delta as string | undefined,
      assistantAudit,
      sourceLifecycles,
    };
  } finally {
    db.close();
  }
};

describe('D-167 P5 S4 — end-to-end through the orchestrator', () => {
  it('is behavior-preserving with the noop resolver (nothing aliased)', async () => {
    const result = await runOrchestratorTurn({
      userMessage: 'contact alice@acme.com',
      aiResponse: () => 'done',
    });
    // Egress carries the real message unchanged; reply unchanged; no summary.
    expect(result.egressPacket.user_message).toBe('contact alice@acme.com');
    expect(result.messageComplete).toBe('done');
    expect(result.assistantAudit).toBeDefined();
    expect(result.assistantAudit).not.toHaveProperty('redaction_summary');
    expect(result.sourceLifecycles).toEqual(['finalized', 'finalized']);
  });

  it('aliases on egress, restores on display, and stamps the audit summary', async () => {
    const result = await runOrchestratorTurn({
      resolver: userMessageEmailResolver,
      userMessage: 'alice@acme.com',
      // The model echoes the alias it was shown.
      aiResponse: (egress) => `mailing ${String(egress.user_message)}`,
    });
    // Egress: the cloud executor never saw the real email.
    expect(result.egressPacket.user_message).not.toBe('alice@acme.com');
    expect(String(result.egressPacket.user_message)).toMatch(/^m\d+@d\d+\.invalid$/);
    // Display: the persisted + broadcast message is fully restored.
    expect(result.messageComplete).toBe('mailing alice@acme.com');
    expect(result.tokenStreamed).toBe('mailing alice@acme.com');
    // Audit: the redaction summary is stamped.
    expect(
      (result.assistantAudit?.redaction_summary as { counts?: { email?: number } } | undefined)
        ?.counts?.email,
    ).toBe(1);
  });

  // The load-bearing reason we wrap executeAiCall (not a single before-turn
  // hook): the tool loop reinvokes the AI with accumulated prior_tool_calls
  // carrying FRESH warehouse PII, so EVERY round's egress must be re-aliased
  // and every round's returned body restored. This drives a real 2-round loop.
  it('re-aliases prior_tool_calls on reinvoke + restores tool args before dispatch (tool loop)', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });
      const captured: Array<Record<string, unknown>> = [];
      const dispatchArgs: unknown[] = [];
      const broadcasts: Array<Record<string, unknown>> = [];
      // Resolver tags the user message + (on reinvoke) the prior tool call's
      // echoed arg + result — i.e. every PII surface the packet carries.
      const resolver: piiEgress.FieldPrivacyResolver = (packet) => {
        const p = packet as Record<string, unknown>;
        const tags: { path: string; kind: 'email' }[] = [];
        if (typeof p.user_message === 'string') {
          tags.push({ path: 'user_message', kind: 'email' });
        }
        if (Array.isArray(p.prior_tool_calls) && p.prior_tool_calls.length > 0) {
          tags.push({ path: 'prior_tool_calls.0.args.email', kind: 'email' });
          tags.push({ path: 'prior_tool_calls.0.result.email', kind: 'email' });
        }
        return tags;
      };
      const registry: InternalToolRegistry = {
        list: () => [],
        listByTier: () => [],
        getByName: (name) =>
          name === 'lookup'
            ? ({
                name: 'lookup',
                tier: 2,
                classification: 'read',
                arg_schema: {},
                concurrency_safe: true,
              } as unknown as ToolEntry)
            : null,
        dispatch: vi.fn(async (_name: string, args: unknown) => {
          dispatchArgs.push(args);
          return { ok: true, result: { email: 'bob@acme.com' } } as const;
        }),
        subscribeRefresh: () => () => undefined,
      };
      let call = 0;
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_m, input) => {
        const packet = JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>;
        captured.push(packet);
        call += 1;
        if (call === 1) {
          // Round 1: echo the (aliased) user_message into a tool-call arg.
          return {
            body: {
              response: 'looking up',
              events: [],
              tool_calls: [{ tool: 'lookup', args: { email: packet.user_message } }],
            } satisfies AIOutput,
          };
        }
        // Reinvoke: echo the (aliased) prior result into the response; stop.
        const prior = packet.prior_tool_calls as Array<{ result?: { email?: string } }>;
        return {
          body: {
            response: `found ${String(prior?.[0]?.result?.email)}`,
            events: [],
            tool_calls: [],
          } satisfies AIOutput,
        };
      });
      let idSeq = 0;
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry,
        broadcast: { emit: (e) => broadcasts.push(e as Record<string, unknown>) },
        selfSignature,
        executeAiCall,
        piiLedgerStore: piiEgress.createSessionLedgerStore(),
        fieldPrivacyResolver: resolver,
        now: () => NOW,
        mintId: () => `id-${++idSeq}`,
      });

      await orchestrator.runTurn({
        session_id: 'sess-1',
        message: 'alice@acme.com',
        picker_state: { current: 'self' },
      });

      expect(call).toBe(2); // a real reinvoke happened
      // Arg restore: dispatch acted on the REAL email, never the alias.
      expect(dispatchArgs[0]).toEqual({ email: 'alice@acme.com' });
      // Reinvoke egress: the fresh warehouse PII (the tool result) was
      // re-aliased before going to the cloud LLM — NOT leaked raw.
      const reinvokePrior = captured[1]?.prior_tool_calls as Array<{
        result?: { email?: string };
      }>;
      expect(reinvokePrior[0]?.result?.email).not.toBe('bob@acme.com');
      expect(String(reinvokePrior[0]?.result?.email)).toMatch(/^m\d+@d\d+\.invalid$/);
      // Final message restores the reinvoke result's alias to the real value.
      const messageComplete = broadcasts.find((b) => b.kind === 'chat.message_complete');
      expect((messageComplete?.final as { content?: string } | undefined)?.content).toBe(
        'found bob@acme.com',
      );
      const harvested = await chatStore.harvestPiiSources!({
        session_id: 'sess-1',
        max_rows: 256,
        max_bytes: 1_048_576,
        max_candidates: 1_024,
      });
      expect(
        harvested.rows.flatMap((row) => row.candidates),
      ).toEqual(expect.arrayContaining([
        { value: 'alice@acme.com', kind: 'email' },
        { value: 'bob@acme.com', kind: 'email' },
      ]));
    } finally {
      db.close();
    }
  });
});

describe('D-167 P5 S4 — session-delete ledger purge', () => {
  it('drops the session PII ledger on chat.session.delete', async () => {
    const drop = vi.fn();
    const deps = {
      store: {
        getSession: () => ({ id: 'sess-1' }),
        listMessages: async () => [],
        deleteSession: () => true,
      },
      selfSignature,
      dropSessionPiiLedger: drop,
    } as unknown as ChatRpcDeps;
    await handleSessionDelete(deps, { session_id: 'sess-1' });
    expect(drop).toHaveBeenCalledWith('sess-1');
  });
});
