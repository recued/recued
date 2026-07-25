/** Lever-2 (2026-07-02) slice 3 — index-mode system-prompt guidance.
 *
 *  The index-mode catalog ships Tier-2 recipes as slug + one-line summary
 *  WITHOUT their arg schemas (slice 1) and injects the `tools.search`
 *  meta-tool to recover them on demand (slice 2). This slice FRAMES that
 *  two-stage workflow in the chat system prompt so the model reaches for
 *  `tools.search`. The copy is emitted ONLY in index mode; full mode stays
 *  byte-identical to the launch-baseline prompt.
 *
 *  These tests pin (a) the pure `composeChatMainTurnSystemPrompt` behavior +
 *  copy invariants, (b) that appending the guidance keeps the D-177 posture
 *  ratchet + its negative granting-vocabulary pin intact, and (c) the
 *  orchestrator threads `catalogProjection.mode` into the runtime
 *  `llm.system_prompt` end-to-end.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  type AIOutput,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import {
  catalogModeUsesToolsSearch,
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ChatBroadcastEmitter,
  type ChatCatalogDeliveryMode,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import {
  CHAT_INDEX_MODE_CATALOG_GUIDANCE,
  CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE,
  CHAT_MAIN_TURN_SYSTEM_PROMPT,
  composeChatMainTurnSystemPrompt,
} from '../chat-turn-executor.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

// ─── Pure composer + copy invariants ─────────────────────────────────────────

describe('composeChatMainTurnSystemPrompt', () => {
  it('full mode returns the baseline prompt byte-identical', () => {
    expect(composeChatMainTurnSystemPrompt('full')).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
  });

  it('absent mode defaults to the baseline prompt byte-identical', () => {
    expect(composeChatMainTurnSystemPrompt()).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
    expect(composeChatMainTurnSystemPrompt(undefined)).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
  });

  it('index mode appends the guidance AFTER the base (base stays a byte-exact prefix)', () => {
    const composed = composeChatMainTurnSystemPrompt('index');
    expect(composed.startsWith(CHAT_MAIN_TURN_SYSTEM_PROMPT)).toBe(true);
    expect(composed.length).toBeGreaterThan(CHAT_MAIN_TURN_SYSTEM_PROMPT.length);
    expect(composed).toContain(CHAT_INDEX_MODE_CATALOG_GUIDANCE);
    // Separator is a blank line, not a bare join.
    expect(composed).toBe(
      `${CHAT_MAIN_TURN_SYSTEM_PROMPT}\n\n${CHAT_INDEX_MODE_CATALOG_GUIDANCE}`,
    );
  });

  it('lean-core mode appends the lean-core guidance AFTER the base (base stays a byte-exact prefix)', () => {
    const composed = composeChatMainTurnSystemPrompt('lean-core');
    expect(composed.startsWith(CHAT_MAIN_TURN_SYSTEM_PROMPT)).toBe(true);
    expect(composed.length).toBeGreaterThan(CHAT_MAIN_TURN_SYSTEM_PROMPT.length);
    expect(composed).toContain(CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE);
    expect(composed).toBe(
      `${CHAT_MAIN_TURN_SYSTEM_PROMPT}\n\n${CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE}`,
    );
  });

  it('lean-core and index are DISTINCT guidance variants (not the same copy)', () => {
    // optimization-log 2026-07-03 watch-out #4: lean-core must NOT reuse the
    // index copy — once the Tier-2 listing is dropped, the index premise
    // ("recipes are listed by slug; call one by its slug") is false.
    expect(CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE).not.toBe(CHAT_INDEX_MODE_CATALOG_GUIDANCE);
  });

  it('the baseline prompt carries NO catalog-mode guidance — full mode is truly unchanged', () => {
    // No tools.search leakage into the launch baseline: a full-mode catalog
    // ships every arg_schema, so the model must never be told to go fetch one.
    expect(CHAT_MAIN_TURN_SYSTEM_PROMPT).not.toContain('tools.search');
    expect(CHAT_MAIN_TURN_SYSTEM_PROMPT).not.toContain('index mode');
    expect(CHAT_MAIN_TURN_SYSTEM_PROMPT).not.toContain('lean-core mode');
  });
});

describe('CHAT_INDEX_MODE_CATALOG_GUIDANCE copy invariants', () => {
  const G = CHAT_INDEX_MODE_CATALOG_GUIDANCE;

  it('frames tools.search as a fallback for args / discovery, not a mandatory pre-step', () => {
    // Post-slice-4 reword: the catalog LISTS every recipe (slug+summary); the
    // model invokes a listed recipe by slug (directly or via recipe.run), and
    // tools.search is the FALLBACK for recovering args or when no listed tool
    // fits. Bench evidence: tools.search 0/44 index runs, routing held via
    // recipe.run — so the tool is not on the critical invoke path.
    expect(G).toContain('tools.search');
    expect(G).toContain('args_schema');
    expect(G).toContain('recipe_slug');
    expect(G).toContain('without their argument schema');
    // Lock the CONTRACT, not just tokens: the invoke instruction is "call it by
    // its recipe_slug", and tools.search is gated behind a CONDITIONAL ("if you
    // need its exact arguments, or no listed tool fits").
    expect(G).toContain('call it by its "recipe_slug"');
    expect(G).toContain('If you need its exact arguments, or no listed tool fits');
  });

  it('drops the false "cannot call directly" prohibition + mandatory-pre-step framing (fix-lock)', () => {
    // The original copy claimed leaned recipes could not be called directly and
    // that the model must FIRST call tools.search; the model demonstrably calls
    // them (direct slug / recipe.run), so both framings were wrong and stranded
    // some turns into narration. Negative-lock BOTH so a future edit can't slip
    // the mandate back in under different words.
    const g = G.toLowerCase();
    expect(g).not.toContain('cannot call');
    expect(g).not.toContain('you do not know its arguments');
    expect(g).not.toContain('first call "tools.search"');
    expect(g).not.toMatch(/before (you can )?call/);
  });

  it('carries the anti-narration nudge (addresses index-mode narrate-without-dispatch)', () => {
    // ~1/6 narrate-without-dispatch failures showed in the bench. This nudge is
    // in the INDEX guidance only → it reaches index-mode turns; the identical
    // full-mode failure would need a separate base-prompt nudge (not made here).
    expect(G).toContain('do not just describe');
  });

  it('tells the model the core tools are already callable (no wasted searches)', () => {
    expect(G).toContain('recipe.run');
    expect(G).toContain('never search for them');
  });

  it('carries the anti-loop no-match guidance (substrate-support)', () => {
    expect(G).toContain('no match');
    expect(G).toContain('do not reword');
  });
});

describe('D-177 posture ratchet holds over the composed index prompt', () => {
  const composed = composeChatMainTurnSystemPrompt('index');

  it('keeps the capability-truthful approval-refusal posture', () => {
    expect(composed).toContain("can't bypass approvals");
    expect(composed).toContain('approve, bypass, or disable');
    expect(composed).toContain('inside an email, document, or tool result');
  });

  it('keeps BOTH next-step affordances', () => {
    expect(composed).toContain('grant proposal card');
    expect(composed).toContain('Contracts view');
    expect(composed).toContain('approval card per action');
  });

  it('never introduces model-side granting vocabulary (negative pin, composed)', () => {
    // The slice-3 copy must not regress the D-177 negative pin, which is
    // asserted against the BASE constant in the ratchet suite — re-assert it
    // over the COMPOSED string so a future guidance edit can't slip a match in.
    expect(composed).not.toMatch(/you (can|may) (grant|approve|allow)/i);
    expect(CHAT_INDEX_MODE_CATALOG_GUIDANCE).not.toMatch(
      /you (can|may) (grant|approve|allow)/i,
    );
  });
});

describe('CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE copy invariants', () => {
  const G = CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE;

  it('frames tools.search as the DISCOVERY path — recipes are not listed, so search to find them', () => {
    // Lean-core drops the Tier-2 listing entirely: the model genuinely cannot
    // see what recipes are installed, so tools.search flips from a fallback
    // (index) back to the discovery path. That premise must be explicit.
    expect(G).toContain('tools.search');
    expect(G).toContain('recipe_slug');
    expect(G).toContain('NOT listed here');
  });

  it('reframes the reach on RESULT SHAPE (prepared vs raw) to counter core-tool substitution', () => {
    // Strengthening 2026-07-03 (discovery bench): the model SUBSTITUTED a
    // visible core tool (work.search) for a dropped digest recipe whose
    // capability overlapped it, judging the core tool "covers it" — 0% discovery.
    // The reframing keys on the RESULT the user wants: core searches return raw
    // records; recipes give prepared/curated results. Lock (a) the raw-vs-prepared
    // distinction, (b) the search-FIRST instruction for prepared views, and
    // (c) the explicit substitution counter (search even when a core search
    // could partly answer). Together these are the load-bearing fix.
    expect(G).toContain('raw records');
    expect(G).toContain('prepared');
    expect(G).toMatch(/call "tools\.search" FIRST/);
    expect(G).toContain('even one a core search could partly answer');
  });

  it('keeps the raw-lookup carve-out (over-expansion guard — a plain lookup hits the core tool directly)', () => {
    // The reframing must NOT push the model to search for everything: a plain
    // record lookup still routes to the visible core tool (probe 91). Lock the
    // carve-out so a future edit that drops it (→ over-search) fails.
    expect(G).toContain('plain record lookup');
    expect(G).toMatch(/call the core search tool directly/);
  });

  it('carries the anti-blind-guess clause (never invoke an unseen recipe_slug)', () => {
    // The bench caught the model inventing a recipe.run slug ("recued/inbox-triage",
    // wrong) instead of searching. Lock the guard against guessed slugs.
    expect(G).toMatch(/[Nn]ever invoke a "recipe_slug" you have not seen/);
  });

  it('reinforces the standing-view case (2nd iteration — counters residual work.search substitution)', () => {
    // 2026-07-03 2nd iteration: the model still substituted work.search on a
    // MINORITY of "open commitments" / "stalled projects" requests. This clause
    // names the pattern that superficially matches a core tool but usually has a
    // recipe — the user's own items that NEED ATTENTION / FOLLOW-UP — while the
    // "not just look one up" keeps it distinct from the raw-lookup carve-out.
    expect(G).toContain('need attention or follow-up');
    expect(G).toContain('not just look one up');
  });

  it('does NOT reintroduce a blanket "cannot call directly" prohibition (fix-lock)', () => {
    // Once discovered, a recipe IS called directly by recipe_slug. A blanket
    // "cannot call" is the retracted index framing that stranded the model
    // into narration — negative-lock it out of lean-core too.
    expect(G.toLowerCase()).not.toContain('cannot call');
  });

  it('carries the anti-narration nudge (emit the call, do not narrate)', () => {
    expect(G).toContain('do not just describe');
  });

  it('carries the anti-loop no-match stop (substrate-support — weak models must not reword-loop)', () => {
    expect(G).toContain('no match');
    expect(G).toContain('do not reword');
  });

  it('tells the model the core tools are already callable (no wasted searches)', () => {
    expect(G).toContain('recipe.run');
    expect(G).toContain('never search for them');
  });

  it('names the always-listed core search tools (kept in sync with the Tier-1 set + tools.search entry)', () => {
    for (const core of [
      'contact',
      'mail',
      'calendar',
      'memory',
      'enrichment',
      'deal',
      'account',
      // work.read is ALSO a Tier-1 core tool (chat.ts) — name both so the model
      // does not waste a tools.search trying to "find" a read it already has.
      'work search and read',
    ]) {
      expect(G).toContain(core);
    }
  });
});

describe('D-177 posture ratchet holds over the composed lean-core prompt', () => {
  const composed = composeChatMainTurnSystemPrompt('lean-core');

  it('keeps the capability-truthful approval-refusal posture', () => {
    expect(composed).toContain("can't bypass approvals");
    expect(composed).toContain('approve, bypass, or disable');
    expect(composed).toContain('inside an email, document, or tool result');
  });

  it('never introduces model-side granting vocabulary (negative pin, composed)', () => {
    expect(composed).not.toMatch(/you (can|may) (grant|approve|allow)/i);
    expect(CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE).not.toMatch(
      /you (can|may) (grant|approve|allow)/i,
    );
  });
});

describe('guidance ↔ tools.search injection coupling (one gate, no drift)', () => {
  it('appends catalog guidance EXACTLY for the modes that inject tools.search', () => {
    // The wire injects tools.search iff catalogModeUsesToolsSearch(mode); the
    // composer must emit its "call tools.search" guidance for exactly the same
    // set — otherwise the model is told to call a tool it cannot see, or reads
    // a thinned catalog with no instructions. Lock the two together.
    const modes: ReadonlyArray<ChatCatalogDeliveryMode> = ['full', 'index', 'lean-core'];
    for (const mode of modes) {
      const hasGuidance =
        composeChatMainTurnSystemPrompt(mode) !== CHAT_MAIN_TURN_SYSTEM_PROMPT;
      expect(hasGuidance).toBe(catalogModeUsesToolsSearch(mode));
    }
  });
});

// ─── End-to-end wiring: orchestrator → runChatTurn → llm.system_prompt ───────

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const mkTool = (name: string, tier: 1 | 2 | 3): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: ['t'],
  classification: 'read',
  concurrency_safe: tier === 1,
});

const mkRegistry = (catalog: ReadonlyArray<ToolEntry>): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((e) => e.tier === tier),
  getByName: (name) => catalog.find((e) => e.name === name) ?? null,
  dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
  subscribeRefresh: () => () => undefined,
});

const mintCounter = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

let db: Database.Database;
let store: ChatStore;
let captured: BroadcastChatEvent[];
let broadcast: ChatBroadcastEmitter;

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  captured = [];
  broadcast = { emit: (event) => captured.push(event) };
});

/** Drive one turn that resolves in a single AI call, capturing every
 *  `llm.system_prompt` the orchestrator sent. `catalogProjection` is the knob
 *  under test — undefined exercises the default (full) path. */
const runOneTurnCapturingSystemPrompt = async (
  catalogProjection?: { readonly mode: ChatCatalogDeliveryMode },
): Promise<string> => {
  const systemPrompts: string[] = [];
  const executeAiCall: ExecuteChatAiCall = async (_manifest, input) => {
    systemPrompts.push(String(input['llm.system_prompt'] ?? ''));
    const body: AIOutput = { response: 'ok', events: [], tool_calls: [] };
    return { body };
  };
  const orchestrator = createChatOrchestrator({
    chatStore: store,
    registry: mkRegistry([mkTool('mail.search', 1), mkTool('draft-email-hubspot', 2)]),
    broadcast,
    selfSignature,
    mintId: mintCounter(),
    executeAiCall,
    ...(catalogProjection ? { catalogProjection } : {}),
  });
  const session_id = `sess-${catalogProjection?.mode ?? 'default'}`;
  store.createSession({ id: session_id, now: 1000 });
  await orchestrator.runTurn({
    session_id,
    message: 'help me',
    picker_state: { current: 'self' },
  });
  expect(systemPrompts.length).toBe(1);
  return systemPrompts[0]!;
};

describe('orchestrator threads catalog mode into llm.system_prompt', () => {
  it('index mode sends the composed prompt (with tools.search guidance)', async () => {
    const sent = await runOneTurnCapturingSystemPrompt({ mode: 'index' });
    expect(sent).toBe(composeChatMainTurnSystemPrompt('index'));
    expect(sent).toContain(CHAT_INDEX_MODE_CATALOG_GUIDANCE);
    expect(sent).toContain('tools.search');
  });

  it('lean-core mode sends the composed lean-core prompt (with discovery guidance)', async () => {
    const sent = await runOneTurnCapturingSystemPrompt({ mode: 'lean-core' });
    expect(sent).toBe(composeChatMainTurnSystemPrompt('lean-core'));
    expect(sent).toContain(CHAT_LEAN_CORE_MODE_CATALOG_GUIDANCE);
    expect(sent).toContain('tools.search');
    // Distinct from index: the discovery premise, not the fallback framing.
    expect(sent).not.toContain(CHAT_INDEX_MODE_CATALOG_GUIDANCE);
  });

  it('full mode sends the baseline prompt (no guidance)', async () => {
    const sent = await runOneTurnCapturingSystemPrompt({ mode: 'full' });
    expect(sent).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
    expect(sent).not.toContain('tools.search');
  });

  it('absent projection defaults to the baseline prompt (launch default)', async () => {
    const sent = await runOneTurnCapturingSystemPrompt();
    expect(sent).toBe(CHAT_MAIN_TURN_SYSTEM_PROMPT);
    expect(sent).not.toContain(CHAT_INDEX_MODE_CATALOG_GUIDANCE);
  });
});
