/** Install packs over the paired connection, so the audit can reach the
 *  subsystems that need REAL substrate rather than a hand-built row.
 *
 *  Two packs, for two different blocked surfaces:
 *
 *    `decision-log` — a RECORDS pack that also ships a `record.created`
 *                     WATCHER (`stamp-decision-review`). Both halves are
 *                     needed: installing it creates the
 *                     `core_record_namespaces` row the outbox is ACCOUNTED
 *                     against, and the watcher is what makes a mutation
 *                     enqueue a PENDING DELIVERY at all — `insertDelivery`
 *                     only fires for matching subscriber bindings, so a
 *                     records pack with no watcher leaves the outbox empty.
 *
 *    `heroku`       — ships an `auto_run` recipe. A NEW roster entry is built
 *                     with `next_run_at: now` (`packages/scheduler/auto-run.ts`),
 *                     so it is DUE IMMEDIATELY. The seed's five pre-existing
 *                     entries were already fired by boot's own catch-up tick
 *                     and advanced an hour out, which is why every tick in the
 *                     previous round fired 0.
 *                     ⚠ Its recipe will FAIL (no Heroku connection). That is
 *                     wanted: a failing fire is what drives the circuit
 *                     breaker, and breaker convergence is the invariant.
 *
 *  ⛔ Two gotchas taken verbatim from the bench's own installer, both of which
 *  it learned the hard way:
 *
 *   1. GRANT WHAT THE MANIFEST DECLARES. Sending `granted_permissions: []`
 *      installs a pack whose recipes are all uncallable.
 *   2. `install_scope` IS THE WRITE-GRANT AXIS and `granted_permissions` is
 *      NOT. Absent ⇒ fail closed to read/ask defaults, so every write is
 *      refused while the install log cheerfully reports N permissions granted.
 *
 *  ⛔ And verify: "the rpc did not throw" is not "the pack works". The install
 *  is confirmed by reading the recipe catalog back, exactly as the bench does
 *  after it once watched a pack report success with zero callable recipes. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { explainLlmRefusal, type LlmSlotSpec } from './llm-env.js';
import type { RpcConn } from './unlock-vault.js';

/** Derived op ids are `<publisher>.<pack>.<entity>.<action>` — entities in a
 *  composition carry only `fields`, so the action set is synthesised. */
const RECORDS_ACTIONS = [
  'create', 'get', 'get_many', 'search', 'count', 'aggregate',
  'update', 'upsert', 'delete', 'batch',
] as const;

export interface PackInstallOutcome {
  readonly slug: string;
  readonly ok: boolean;
  /** Recipe slugs the manifest declares that came back callable. */
  readonly callable: number;
  readonly declared: number;
  readonly detail: string;
}

interface PackManifest {
  publisher?: string;
  requires?: unknown;
  contents?: Array<{
    type?: string;
    slug?: string;
    composition?: {
      slug?: string;
      ingredients?: Array<{ entities?: Record<string, unknown> }>;
    };
  }>;
}

export const installPack = async (
  conn: RpcConn,
  packsDir: string,
  slug: string,
): Promise<PackInstallOutcome> => {
  const manifestPath = join(packsDir, `${slug}.json`);
  if (!existsSync(manifestPath)) {
    return {
      slug,
      ok: false,
      callable: 0,
      declared: 0,
      detail: `no manifest at ${manifestPath}`,
    };
  }
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackManifest;
  } catch (err) {
    return {
      slug,
      ok: false,
      callable: 0,
      declared: 0,
      detail: `manifest unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const composition = (manifest.contents ?? [])
    .find((item) => item?.type === 'composition')?.composition;
  const opGrants: string[] = [];
  for (const ing of composition?.ingredients ?? []) {
    for (const entity of Object.keys(ing?.entities ?? {})) {
      for (const action of RECORDS_ACTIONS) {
        opGrants.push(
          `${manifest.publisher}.${composition?.slug}.${entity}.${action}`,
        );
      }
    }
  }
  const granted = [
    ...(Array.isArray(manifest.requires) ? (manifest.requires as string[]) : []),
    ...opGrants,
  ];

  const declaredSlugs = (manifest.contents ?? [])
    .filter((item) => item?.type === 'recipe')
    .map((item) => item.slug)
    .filter((x): x is string => typeof x === 'string');

  // ⛔ READ THE INSTALL RESULT. `recipe.list` alone is NOT a verification for a
  // FIRST-PARTY pack: its recipes are BUNDLED, so they are listed whether or
  // not the pack installed. That is how this installer reported "4/4 recipes
  // callable" for a `decision-log` install that had actually come back
  // `ok: false, validator_rejected` — and the run then failed downstream with
  // `pack_not_installed`, three layers from the cause. The bench's read-back
  // check is right for MARKETPLACE packs and insufficient here.
  try {
    const res = (await conn.rpc(
      'packs.install',
      { manifest, granted_permissions: granted, install_scope: { access: 'all' } },
      60_000,
    )) as { result?: { ok?: boolean; failure?: { code?: string; message?: string } } }
      | undefined;
    const outcome = res?.result;
    if (outcome?.ok === false) {
      return {
        slug,
        ok: false,
        callable: 0,
        declared: declaredSlugs.length,
        detail:
          `packs.install refused: ${outcome.failure?.code ?? 'unknown'} — `
          + `${outcome.failure?.message ?? 'no message'}`,
      };
    }
  } catch (err) {
    return {
      slug,
      ok: false,
      callable: 0,
      declared: declaredSlugs.length,
      detail: `packs.install threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ⛔ Read the catalog back. A pack that installs with zero callable recipes
  // reports success at the rpc and is useless as substrate.
  let callable = 0;
  try {
    const listed = (await conn.rpc('recipe.list', {})) as {
      recipes?: Array<{ slug?: string; recipe_id?: string }>;
    } | undefined;
    const have = new Set(
      (listed?.recipes ?? [])
        .map((r) => r.slug ?? r.recipe_id)
        .filter((x): x is string => typeof x === 'string'),
    );
    callable = declaredSlugs.filter((s) => have.has(s)).length;
  } catch (err) {
    return {
      slug,
      ok: false,
      callable: 0,
      declared: declaredSlugs.length,
      detail: `recipe.list threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ok = declaredSlugs.length === 0 || callable > 0;
  return {
    slug,
    ok,
    callable,
    declared: declaredSlugs.length,
    detail: ok
      ? `${callable}/${declaredSlugs.length} recipes callable, ${granted.length} permission(s) granted`
      : `installed but 0/${declaredSlugs.length} recipes callable — unusable as substrate`,
  };
};

/** Create one record through the pack's own recipe.
 *
 *  ⛔ THIS is what makes `records-outbox` drivable. The outbox is accounted
 *  against a `core_record_namespaces` row: `failDelivery` ends in
 *  `decrementOutboxAccounting`, which requires that row with
 *  `outbox_count > 0`. A raw-SQL seed cannot produce that pairing — it throws
 *  `Records outbox accounting decrement failed`, which the tick swallows into a
 *  console.warn, so the queue silently does not drain and the tick looks clean.
 *
 *  Running the real recipe takes the real enqueue path, which increments the
 *  accounting alongside the event. That is the difference between substrate and
 *  a hand-built row. */
/** Pull a labelled value out of a run's rendered summary card.
 *
 *  ⚠ `ServerExecuteResponse.steps[]` carries only metadata — id, type, skipped,
 *  duration, error — NOT step outputs. The rendered output is the only place a
 *  created record's id reaches the caller, so the pack's own summary card is
 *  the seam. */
const renderedValue = (res: unknown, label: string): string | undefined => {
  const json = JSON.stringify(res ?? null);
  const hit = new RegExp(
    `"label"\\s*:\\s*"${label}"\\s*,\\s*"value"\\s*:\\s*"([^"]+)"`,
  ).exec(json);
  return hit?.[1];
};

export const createRecordViaRecipe = async (
  conn: RpcConn,
  recipe_id: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string; recordId?: string; awaitingApproval?: boolean }> => {
  try {
    const res = (await conn.rpc(
      'execute',
      { recipe_id, config, trigger_source: 'manual' },
      60_000,
    )) as {
      success?: boolean;
      awaiting_approval?: boolean;
      errors?: Array<{ message?: string }>;
    } | undefined;
    // ⛔ A PAUSE IS NOT A FAILURE. `awaiting_approval` comes back with
    // `success: false` and an EMPTY errors array — read as a plain failure it
    // looks identical to a broken recipe, which is exactly the confusion this
    // audit exists to break.
    if (res?.awaiting_approval === true) {
      return {
        ok: true,
        awaitingApproval: true,
        detail: 'paused at the preflight approval gate (checkpoint + ask raised)',
      };
    }
    if (res?.success === true) {
      const id = renderedValue(res, 'Id');
      return {
        ok: true,
        detail: id === undefined ? 'record created' : `record created (${id})`,
        ...(id !== undefined ? { recordId: id } : {}),
      };
    }
    // ⚠ Dump the shape, not just `errors[0].message`. A run can fail with an
    // empty `errors` array (a guard/fail_on halt), and "no error message" tells
    // the reader nothing about which step stopped it.
    const first = res?.errors?.[0]?.message;
    return {
      ok: false,
      detail: `execute returned success=false: ${
        first ?? `result=${JSON.stringify(res ?? null)}`.slice(0, 400)
      }`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `execute threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/** Drive one real chat turn so the MODEL writes an execution report.
 *
 *  ⛔ The only writer of `execution_reports` is the model calling the
 *  `outcome_report` tool mid-turn. There is no non-AI path, so
 *  `execution-case-sources-prune` cannot be driven against anything else.
 *
 *  ⚠ NON-DETERMINISTIC BY CONSTRUCTION. Whether a report lands depends on the
 *  model choosing to call the tool. The caller must treat "no report" as
 *  "not driven this run", never as "the prune is broken" — the bench's own
 *  chat lane carries the same caveat. */
/** The slice of a redacted slot the matcher actually reads. */
interface SlotView {
  provider?: string;
  model?: string;
  has_key?: boolean;
  speed?: string;
  supports_json?: boolean;
}

export const persistLlmSlot = async (
  conn: RpcConn,
  slot: LlmSlotSpec,
  slot2?: LlmSlotSpec,
): Promise<string> => {
  try {
    // ⚠ ONE call carrying BOTH slots. `setLLMConfig` replaces the config it is
    // given; persisting slot_2 in a second call would drop slot_1 and the run
    // would read back a config missing the very slot it just wrote.
    await conn.rpc(
      'server.setLLMConfig',
      { config: { slot_1: slot, ...(slot2 ? { slot_2: slot2 } : {}) } },
      30_000,
    );
    return slot2 ? 'slot_1 + slot_2 persisted' : 'slot_1 persisted';
  } catch (err) {
    return `setLLMConfig FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/** What the server ACTUALLY holds, read back over the same rpc a fresh boot
 *  would read. Answers the one question the refusal message cannot: is the
 *  persisted slot invisible (a persistence / decrypt problem) or visible but
 *  unmatched (a matcher problem)? Guessing between those two cost a full round.
 *
 *  ⚠ Shape only — presence + provider + model. The key is never read back into
 *  the report. */
export const describeLlmConfig = async (conn: RpcConn): Promise<string> => {
  try {
    // ⛔ The payload is WRAPPED: `{ config: redactLLMConfig(...) }`. Reading
    // `slot_1` off the top level yields `undefined` for every slot, which
    // renders as a confident "slot_1=unset" — a diagnostic that blames the
    // server for the diagnostic's own bug. It cost a round here before the
    // wrapper was read out of `config-schema.ts`.
    // ⚠ `redactLLMConfig` also strips `api_key` and substitutes a `has_key`
    // boolean, so "the slot is present" and "the slot has a usable key" are
    // separate facts and both are reported below.
    // ⛔ REPORT THE FIELDS THE MATCHER GATES ON, not just presence. `slotMatches`
    // rejects on `speed !== filter.speed` and on `require_json && !supports_json`
    // BEFORE anything touches the network, so a slot that is present, keyed and
    // reachable can still be skipped — and the refusal the user sees ("No AI
    // model is available for your current model preference") is the same
    // sentence as an unconfigured server. Printing provider/model/key alone
    // cost this audit a full round chasing a live-provider theory while the
    // rejection was a field comparison.
    const resp = (await conn.rpc('server.getLLMConfig', {})) as {
      config?: {
        slot_1?: SlotView;
        slot_2?: SlotView;
        free_pool?: unknown[];
      };
    } | undefined;
    const cfg = resp?.config;
    if (!cfg) return 'getLLMConfig returned no config';
    const slot = (s: SlotView | undefined): string =>
      s
        ? `${s.provider ?? '?'}/${s.model ?? '?'}(key=${s.has_key === true}`
          + `,speed=${s.speed ?? 'unset'},json=${s.supports_json ?? 'unset'})`
        : 'unset';
    return `slot_1=${slot(cfg.slot_1)} slot_2=${slot(cfg.slot_2)} `
      + `free_pool=${(cfg.free_pool ?? []).length}`;
  } catch (err) {
    return `getLLMConfig FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const driveChatTurn = async (
  conn: RpcConn,
  message: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; detail: string }> => {
  try {
    // ⛔ SUBSCRIBE FIRST. Without it the client receives only `server_heartbeat`
    // and its own `rpc_result` frames — verified by counting frame types across
    // a full run. `chat.message_complete` never arrives and the turn wait times
    // out on a turn that actually completed (2 chat_messages persisted), which
    // reads as a broken chat lane rather than an unsubscribed client.
    await conn.rpc('events.subscribe', {
      kinds: [
        'chat.message_complete',
        'chat.tool_call_started',
        'chat.tool_call_completed',
        // ⛔ THE ONLY MACHINE-READABLE REASON FOR A REFUSAL. The assistant
        // message is one sentence for every failure class, so "the matcher
        // found no source", "the provider call failed" and "the model returned
        // unparseable output" are the SAME text. `engine.decoder_unavailable`
        // carries `reason: no_source | provider_failure | invalid_output` —
        // which is the difference between a config problem, a credential
        // problem, and a model problem. Without it this audit spent a round
        // testing a live-provider theory against a matcher that was fine.
        'chat.transparency',
      ],
    }).catch(() => undefined);
    // ⛔ POINT CHAT AT THE CONFIGURED SLOT. A BYOK slot existing is not the
    // same as chat USING it: the default model preference is a separate
    // per-pair setting, and with it unset the turn completes normally while
    // the assistant message reads "No AI model is available for your current
    // model preference". The turn succeeds, the report is never written, and
    // nothing anywhere reports an error.
    // ⚠ NOT swallowed — this audit has already been bitten twice by a
    // catch-and-continue turning a refusal into a silent null.
    let prefDetail = 'slot_1';
    try {
      await conn.rpc('chat.default_model_pref.set', { source_id: 'slot_1' });
    } catch (err) {
      prefDetail = `pref.set FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
    const created = (await conn.rpc('chat.session.create', {}, 30_000)) as
      { session_id?: string } | undefined;
    const session_id = created?.session_id;
    if (typeof session_id !== 'string') {
      return { ok: false, detail: 'chat.session.create returned no session_id' };
    }
    const sent = (await conn.rpc(
      'chat.send',
      { session_id, message, picker_state: { current: 'self' } },
      timeoutMs,
    )) as { turn_id?: string } | undefined;
    if (typeof sent?.turn_id !== 'string') {
      return { ok: false, detail: 'chat.send returned no turn_id' };
    }
    // ⚠ The realtime envelope is `{ type: 'server_event', event: { kind, … } }`
    // — the kind is NESTED. Matching `frame.kind` silently never fires and the
    // wait times out on a turn that actually completed.
    // Collected while the turn runs; read only if the turn refuses.
    const failureReasons: string[] = [];
    const frame = await conn.waitForBroadcast(
      (f) => {
        const ev = f.event as {
          kind?: string;
          turn_id?: string;
          event?: { kind?: string; reason?: string; site?: string };
        } | undefined;
        if (
          ev?.kind === 'chat.transparency'
          && ev.turn_id === sent.turn_id
          && ev.event?.kind === 'engine.decoder_unavailable'
        ) {
          failureReasons.push(`${ev.event.reason ?? '?'}@${ev.event.site ?? '?'}`);
        }
        return ev?.kind === 'chat.message_complete' && ev.turn_id === sent.turn_id;
      },
      timeoutMs,
    );
    const ev = frame.event as { final?: { content?: string } } | undefined;
    const reply = ev?.final?.content ?? '';
    const why = failureReasons.length > 0
      ? ` | decoder_unavailable: ${[...new Set(failureReasons)].join(', ')}`
      : '';
    return {
      ok: true,
      detail: `[pref ${prefDetail}] turn ${sent.turn_id} — ${reply.slice(0, 110)}${why}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `chat turn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

export const installAuditSubstrate = async (
  conn: RpcConn,
  packsDir: string,
  devEnvPath: string,
): Promise<readonly PackInstallOutcome[]> => {
  const out: PackInstallOutcome[] = [];
  // ⛔ WHY `decision-log` AND NOT AN EXISTING PACK. A mutation with no
  // SUBSCRIBER enqueues no delivery, and the corpus's two records watchers were
  // both tried and are blocked on substrate this harness has no honest way to
  // supply:
  //   job-status-board / open-job-from-intake  → fails `require_contract`
  //     (`{{context.caller.contract_id}} is_null`) — gateway-dispatched, and
  //     fabricating a caller contract_id is exactly the hand-built state this
  //     audit refuses to invent.
  //   field-service-day-plan / add-service-site → denied
  //     `recued-core/nominatim.geo.search … no_connection_profile`.
  // `decision-log` was authored to close that gap: a records watcher whose
  // create path needs neither a gateway contract nor an outbound connection.
  for (const slug of ['decision-log', 'heroku']) {
    out.push(await installPack(conn, packsDir, slug));
  }
  // Real mutations through the real enqueue path, which maintains the outbox
  // accounting a raw-SQL seed cannot.
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['log-decision', {
      title: 'Drive the outbox from a real subscriber',
      rationale: 'a hand-built delivery row cannot carry the accounting',
      review_in_days: 90,
    }],
  ];
  let createdId: string | undefined;
  for (const [recipe_id, config] of mutations) {
    const rec = await createRecordViaRecipe(conn, recipe_id, config);
    if (rec.recordId !== undefined) createdId = rec.recordId;
    out.push({
      slug: `${recipe_id} (record mutation)`,
      ok: rec.ok,
      callable: rec.ok ? 1 : 0,
      declared: 1,
      detail: rec.detail,
    });
  }

  // ⛔ Drive one run into the PREFLIGHT APPROVAL GATE. `decision.delete` is
  // `risk: destructive, approval: always` and binds a storage op, so it needs
  // no connection — which matters, because the gateway resolves the connection
  // profile BEFORE the approval gate: every API pack's gated op is denied
  // `no_connection_profile` and never reaches a pause (verified against
  // `heroku.dyno.restart_one`). A paused run writes the checkpoint row + the
  // `awaiting_approval` audit anchor + the ask that `checkpoint-stale-prune`
  // exists to reap.
  if (createdId !== undefined) {
    const paused = await createRecordViaRecipe(conn, 'retire-decision', {
      decision_id: createdId,
    });
    out.push({
      slug: 'retire-decision (preflight approval)',
      ok: paused.awaitingApproval === true,
      callable: paused.awaitingApproval === true ? 1 : 0,
      declared: 1,
      detail: paused.awaitingApproval === true
        ? paused.detail
        : `did NOT pause — ${paused.detail}`,
    });
  }
  // What the server actually holds, BEFORE the turn — so a refusal can be
  // attributed to persistence vs matching without another whole round.
  const llmShape = await describeLlmConfig(conn);
  out.push({
    slug: 'llm config (read back over rpc)',
    ok: llmShape.startsWith('slot_1=') && !llmShape.startsWith('slot_1=unset'),
    callable: 1,
    declared: 1,
    detail: llmShape,
  });
  // One real chat turn — the only path that can produce an execution report.
  const turn = await driveChatTurn(
    conn,
    'Run the list-decisions recipe and tell me what it returned.',
  );
  // A refusal gets ATTRIBUTED, not just reported. The turn's one-size message
  // cannot distinguish "not configured" from "configured and rate-limited".
  const refused = !turn.ok || /No AI model is available/.test(turn.detail);
  const why = refused ? ` | why: ${await explainLlmRefusal(devEnvPath)}` : '';
  out.push({
    slug: 'chat turn (execution report substrate)',
    ok: turn.ok && !refused,
    callable: turn.ok && !refused ? 1 : 0,
    declared: 1,
    detail: `[llm ${llmShape}] ${turn.detail}${why}`,
  });
  return out;
};
