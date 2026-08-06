/** Drive ONE chat session for many turns and measure what the model receives.
 *
 *      npx tsx backend/server/scripts/horizon-audit/chat-long-run.ts [turns]
 *
 *  ⛔ WHY THIS EXISTS. Nothing had ever run a long chat conversation against a
 *  live model. The store-level contract is pinned (`chat-long-conversation
 *  .test.ts`: the tail read is O(1) in conversation length and returns the last
 *  `CHAT_TAIL_LIMIT` messages) — but a store test cannot answer the question
 *  that actually matters to someone using the product: does turn 40 of a
 *  conversation cost more, or fail, because turns 1-39 happened?
 *
 *  🔑 THE MEASUREMENT IS `input_tokens` PER TURN, not latency and not "did it
 *  answer". `recued.token_usage` fires once per turn with the aggregate the
 *  provider billed, so a packet that grows with conversation length shows up as
 *  a rising series and a bounded one shows up as flat. Latency would confound
 *  provider variance with packet growth; "did it answer" only fails at the very
 *  end, after the cost is already unpayable.
 *
 *  ⚠ THE TURNS MUST NOT BE IDENTICAL. A repeated prompt invites provider-side
 *  prompt caching, which flattens the series for a reason that has nothing to
 *  do with what the engine sent — a saturated measure reading as a clean null.
 *  Each turn carries its own index and a distinct question.
 *
 *  ⚠ REPORTS, NEVER ASSERTS A THRESHOLD. What counts as "too big" depends on
 *  the slot's context window, which differs per provider; the honest output is
 *  the series plus the growth ratio, and a non-zero exit only when a turn
 *  actually FAILS. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootInstrumentedServer } from './boot.js';
import { openServerVault, type RpcConn } from './unlock-vault.js';
import { configureLlmFromDevEnv } from './llm-env.js';

const REPO = resolve(import.meta.dirname, '../../../..');
// The bench seed is a sibling checkout that is NOT part of this repository and
// whose directory name is local to the machine it was cloned on. `HORIZON_SEED_DIR`
// names it; this fallback stays neutral so no local layout ships in the source.
const DEFAULT_SEED = resolve(REPO, '..', 'bench-seed');

interface TurnRecord {
  readonly index: number;
  readonly ok: boolean;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly ms: number;
  readonly reply_chars: number;
  /** `engine.catalog_assembled` section counts — how many tool entries the
   *  turn's catalog actually carried. Captured because three catalog
   *  configurations produced a byte-identical `input_tokens`, and "the knob
   *  did nothing" and "the catalog is not the dominant term" look the same
   *  from the token count alone. */
  readonly catalog?: Readonly<Record<string, number>>;
  readonly note?: string;
}

/** Distinct, self-contained questions. Deliberately NOT a running thread — a
 *  follow-up ("and the next one?") would make a failure ambiguous between
 *  "the model lost context" and "the packet got too big", and only the second
 *  is under test here. */
const PROMPTS: readonly string[] = [
  'In one sentence: what is the decision log for?',
  'Name one thing a recipe can do that a transform cannot.',
  'What does it mean for an approval to be "fail-closed"?',
  'Give one reason to keep an audit trail separate from user memory.',
  'In one sentence: why would a server prune its own audit log?',
  'What is the difference between a mirror collection and authored data?',
  'Name one risk of running a recipe without a preflight gate.',
  'In one sentence: what makes a credential "bring your own key"?',
];

const sendTurn = async (
  conn: RpcConn,
  session_id: string,
  index: number,
  timeoutMs: number,
): Promise<TurnRecord> => {
  const message = `[turn ${index}] ${PROMPTS[index % PROMPTS.length]}`;
  const started = Date.now();
  try {
    const sent = (await conn.rpc(
      'chat.send',
      { session_id, message, picker_state: { current: 'self' } },
      timeoutMs,
    )) as { turn_id?: string } | undefined;
    if (typeof sent?.turn_id !== 'string') {
      return { index, ok: false, ms: Date.now() - started, reply_chars: 0,
        note: 'chat.send returned no turn_id' };
    }

    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    let catalog: Readonly<Record<string, number>> | undefined;
    let failure: string | undefined;
    // ⚠ The realtime envelope nests the kind under `event`. Matching a flat
    // `frame.kind` silently never fires and the wait times out on a turn that
    // completed — a trap this harness has already paid for once.
    const frame = await conn.waitForBroadcast(
      (f) => {
        const ev = f.event as {
          kind?: string;
          turn_id?: string;
          event?: {
            kind?: string; reason?: string;
            input_tokens?: number; output_tokens?: number;
            section_counts?: Readonly<Record<string, number>>;
          };
        } | undefined;
        if (ev === undefined || ev.turn_id !== sent.turn_id) return false;
        if (ev.kind === 'chat.transparency') {
          if (ev.event?.kind === 'recued.token_usage') usage = ev.event;
          if (ev.event?.kind === 'engine.catalog_assembled') {
            catalog = ev.event.section_counts;
          }
          if (ev.event?.kind === 'engine.decoder_unavailable') {
            failure = ev.event.reason ?? 'decoder_unavailable';
          }
        }
        return ev.kind === 'chat.message_complete';
      },
      timeoutMs,
    );
    // ⚠ THE CONTENT IS NESTED UNDER `final`, not on the event. Reading
    // `event.content` yields '' for every turn, which this harness then
    // reported as "no reply" — 12 FAILs on 12 turns the model actually
    // answered (24 messages persisted, 344-727 output tokens each). An
    // instrument that cannot see the answer says the product produced none.
    const reply = (frame.event as { final?: { content?: string } } | undefined)
      ?.final?.content ?? '';
    return {
      index,
      ok: failure === undefined && reply.length > 0,
      ...(usage?.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
      ...(usage?.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}),
      ms: Date.now() - started,
      reply_chars: reply.length,
      ...(catalog ? { catalog } : {}),
      ...(failure ? { note: failure } : {}),
    };
  } catch (err) {
    return {
      index, ok: false, ms: Date.now() - started, reply_chars: 0,
      note: err instanceof Error ? err.message : String(err),
    };
  }
};

const main = async (): Promise<number> => {
  const turns = Number(process.argv[2] ?? process.env.CHAT_TURNS ?? 12);
  const workDir = process.env.HORIZON_WORKDIR ?? resolve(REPO, '.chat-long-scratch');
  const seedDir = process.env.HORIZON_SEED_DIR ?? DEFAULT_SEED;
  const seedDb = resolve(seedDir, 'seed-test.db');
  const seedIdentity = resolve(seedDir, 'seed-identity.json');
  const seedRecoveryKey = resolve(seedDir, 'seed-recovery-key.txt');
  const port = Number(process.env.HORIZON_PORT ?? 47910);

  if (!existsSync(seedDb) || !existsSync(seedIdentity)) {
    console.error(`[chat-long] enrolled seed not found under ${seedDir}`);
    return 1;
  }

  const DEV_ENV_PATH = resolve(REPO, '../dev.env');
  const llm = configureLlmFromDevEnv(DEV_ENV_PATH);
  if (!llm.configured || !llm.slot) {
    console.error(`[chat-long] no LLM credential — ${llm.detail}`);
    return 1;
  }
  console.error(`[chat-long] llm: ${llm.detail}`);

  // Two-phase, for the same reason `run.ts` is: the chat orchestrator
  // SNAPSHOTS the LLM config at boot, so a `setLLMConfig` write only lands on
  // the NEXT boot.
  const phase1 = spawnSync(
    process.execPath,
    ['--import', 'tsx',
      fileURLToPath(new URL('./llm-phase1.ts', import.meta.url)),
      workDir, seedDb, seedIdentity, String(port + 1), seedRecoveryKey, DEV_ENV_PATH],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  console.error(
    `[chat-long] llm phase 1: ${(phase1.stdout ?? '').trim().split('\n').pop() ?? 'no output'}`,
  );

  const booted = await bootInstrumentedServer({
    workDir, seedDb, seedIdentity, port, reuseWorkDir: true,
  });
  const vault = await openServerVault({ port, recoveryKeyPath: seedRecoveryKey });
  if (!vault.ok) {
    console.error(`[chat-long] vault not opened — ${vault.reason}`);
    await booted.shutdown();
    return 1;
  }
  const conn = vault.conn;

  await conn.rpc('events.subscribe', {
    kinds: ['chat.message_complete', 'chat.transparency'],
  }).catch(() => undefined);
  await conn.rpc('chat.default_model_pref.set', { source_id: 'slot_1' })
    .catch(() => undefined);

  const created = (await conn.rpc('chat.session.create', {}, 30_000)) as
    { session_id?: string } | undefined;
  const session_id = created?.session_id;
  if (typeof session_id !== 'string') {
    console.error('[chat-long] chat.session.create returned no session_id');
    conn.close();
    await booted.shutdown();
    return 1;
  }

  console.error(`[chat-long] session ${session_id} — driving ${turns} turns…\n`);
  const records: TurnRecord[] = [];
  for (let i = 0; i < turns; i++) {
    const rec = await sendTurn(conn, session_id, i, 180_000);
    records.push(rec);
    console.error(
      `  turn ${String(i).padStart(3)}  ${rec.ok ? 'ok  ' : 'FAIL'}`
      + `  in=${String(rec.input_tokens ?? '?').padStart(7)}`
      + `  out=${String(rec.output_tokens ?? '?').padStart(5)}`
      + `  ${String(rec.ms).padStart(6)}ms  reply=${rec.reply_chars}c`
      + (rec.catalog ? `  catalog=${JSON.stringify(rec.catalog)}` : '  catalog=?')
      + (rec.note ? `  — ${rec.note}` : ''),
    );
  }

  // ⚠ `chat.session.export` — there is no `chat.session.messages` rpc. Used
  // only to confirm the session really accumulated the turns; a flat token
  // series means nothing if the messages were never persisted.
  const exported = (await conn.rpc('chat.session.export', { session_id }, 60_000)
    .catch(() => undefined)) as { messages?: unknown[] } | undefined;

  conn.close();
  await booted.shutdown();

  // ── Report ────────────────────────────────────────────────────────────
  const measured = records.filter((r) => typeof r.input_tokens === 'number');
  const failed = records.filter((r) => !r.ok);
  console.error('\n══ LONG-CONVERSATION RESULT ══\n');
  console.error(`turns driven      : ${records.length}`);
  console.error(`turns answered    : ${records.length - failed.length}`);
  console.error(`messages persisted: ${exported?.messages?.length ?? '?'}`);

  if (measured.length >= 2) {
    const first = measured[0].input_tokens!;
    const last = measured[measured.length - 1].input_tokens!;
    const max = Math.max(...measured.map((r) => r.input_tokens!));
    const min = Math.min(...measured.map((r) => r.input_tokens!));
    console.error(
      `\ninput_tokens      : first=${first} last=${last} min=${min} max=${max}`,
    );
    console.error(`growth first→last : ${(last / first).toFixed(3)}×`);
    console.error(`spread max/min    : ${(max / min).toFixed(3)}×`);
    console.error(
      '\n⚠ A packet that grows with conversation length shows as a rising\n'
      + '  series. A flat series means the tail cap is holding and the cost of\n'
      + '  turn N is independent of turns 1..N-1 — the property the store test\n'
      + '  pins and this run confirms against a live provider.',
    );
  } else {
    // ⛔ Say so. "No usage reported" must not read the same as "flat".
    console.error(
      '\n⛔ NO TOKEN USAGE MEASURED — the series above is empty, which is NOT\n'
      + '  the same as "the packet did not grow". Nothing is concluded.',
    );
  }
  if (failed.length > 0) {
    console.error(`\n⛔ ${failed.length} turn(s) FAILED:`);
    for (const f of failed) console.error(`   turn ${f.index}: ${f.note ?? 'no reply'}`);
    return 1;
  }
  return measured.length >= 2 ? 0 : 1;
};

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('[chat-long] fatal:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
