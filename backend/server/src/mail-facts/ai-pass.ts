/**
 * D-315 — the AI pass (§4.3): the last pass, and the only one that calls a
 * model. It fills what an AI-on template allows and no rule read — data paths,
 * and variables outside the entrance, identity included (rulings 37, 39) — and
 * never adds or removes a fact, never overwrites a value.
 *
 *   one email per call, so each fact is filled from its own email alone
 *   through the chat's privacy layer (ruling 30): the email goes out as the
 *     chat's own mail read does — a tool result, aliased against the whole
 *     warehouse's contacts — and an aliasing error makes no call. The owner's
 *     prompt is the user's message, and is treated as a chat message is: the
 *     owner's own words go as written (D-224)
 *   the answer mapped back, then the alias guard (§9): a value or key still in
 *     alias form is refused, "alias not restored"
 *   every value checked as a rule's is before it is stored (§9)
 *   the pool is the template's; background AI obeys Pause-AI, and uses the
 *     owner's own keys only when background BYOK is on (D-132)
 *
 * Queued (`mail_fact_ai_job`) and run one call at a time — mail that can start
 * recipes first, live mail before a backfill's — so a restart loses nothing. A
 * job whose mailbox is not live yet waits for it (after a restart the mailboxes
 * go live one by one, and a job read before its own was would find no email).
 * When the AI cannot answer — paused, the background budget spent, no model —
 * the facts go on with what the rules read and each records why.
 *
 * Spec: D-315 §4.3, §9.
 */

import {
  canonicalMailFactText,
  getMailFactBuiltinType,
  KERNEL_AUTHOR,
  MAIL_FACT_PII_ENTITY,
  mailFactDataPlaceTaken,
  mailFactEmptyAiSlots,
  mailFactTypeVariables,
  PII_ENTITY_MARKER_KEY,
  type IngredientManifest,
  type MailFact,
  type MailFactEmailRef,
  type MailFactPass,
  type MailFactPoolPolicy,
  type MailFactRefusal,
  type MailFactTypeSpec,
  type MailFactValue,
  type MailTemplate,
} from '@recued/contracts';
import { holdsPiiAliasToken } from '@recued/transforms';

import type { MailCollection } from '../collections/mail/mail-collection.js';
import type { MailFactAiJob, MailFactStore } from '../storage/mail-fact-store.js';
import type { MailFactAiReading, MailFactWriter } from './fact-writer.js';
import { normalizeJsonNumber, normalizeValue } from './normalize.js';
import { finishFact, MAIL_FACT_DATA_MAX_BYTES, setPath } from './rules-pass.js';
import { storedCopyEmail, type StoredEmailDeps } from './stored-email.js';

/** The email as the AI reads it: the stored copy (§5). */
export interface MailFactAiEmail {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** ISO 8601. */
  readonly date: string;
  readonly body_text: string;
}

/** The model's layer, from the template's pool (D-132's words). */
export type MailFactAiLayer = 'free' | 'byok' | 'any';

/** One model call through the chat's privacy layer. Resolves to the answer
 *  mapped back to real values; throws when no call could be made or answered. */
export type MailFactAiCall = (
  input: Record<string, unknown>,
  opts: { readonly timeout_ms: number },
) => Promise<unknown>;

/** A model call through the chat's privacy layer (`privateAiCall`), as a
 *  `MailFactAiCall` under one manifest. Absent ⇒ every call answers that no
 *  model is configured, which the pass records on the fact. */
export const mailFactAiCallThrough = (
  privateAiCall: ((manifest: IngredientManifest, input: Record<string, unknown>, opts?: { readonly timeout_ms?: number }) => Promise<{ readonly body: unknown }>) | undefined,
  manifest: IngredientManifest,
): MailFactAiCall => async (input, opts) => {
  if (privateAiCall === undefined) {
    throw Object.assign(new Error('no model is configured'), { code: 'AI_LLM_UNAVAILABLE' });
  }
  return (await privateAiCall(manifest, input, opts)).body;
};

export interface MailFactAiDeps {
  readonly store: MailFactStore;
  readonly writer: Pick<MailFactWriter, 'applyAi'>;
  readonly readEmail: (ref: MailFactEmailRef) => Promise<MailFactAiEmail | null>;
  readonly call: MailFactAiCall;
  /** The owner's Pause-AI switch (D-132). */
  readonly isPaused: () => boolean;
  /** The daily token budget has reached the point where background work
   *  stops (`schedule_cutoff`). Absent ⇒ never. */
  readonly budgetSpent?: () => boolean;
  /** Whether a mailbox is live, so its emails can be read. Absent ⇒ always. */
  readonly mailboxLive?: (slug: string) => boolean;
  /** Resolves once the trigger queue has room. An answer that may start
   *  recipes waits here before it is placed, as a backfill's email does: a
   *  burst of answers must not overflow the queue and lose an event its fact
   *  would then never announce again. */
  readonly triggerRoom?: () => Promise<void>;
  /** Whether background AI may use the owner's own keys (D-132). */
  readonly byokAllowed: () => boolean;
  readonly now: () => number;
  readonly logger?: { warn(message: string, detail?: unknown): void };
  /** Per call. Default {@link MAIL_FACT_AI_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** After an unexpected failure, the runner tries again this long after, and
   *  twice as long each time it fails again, up to ten minutes. Default 30 s. */
  readonly retryDelayMs?: number;
  /** How often a wait for an email's news looks again, for a call that went
   *  another way — its email deleted, say. Default 1 s. */
  readonly settleRecheckMs?: number;
}

export interface MailFactAiRunner {
  /** Work through the queue, one call at a time. Safe to call at any time. */
  kick(): void;
  /** Resolves once no call holding news waits on the email — answered, or
   *  gone another way — with the events its answers told. A backfill that
   *  runs recipes waits for it before the next email (§6.3). */
  untilSettled(email: MailFactEmailRef): Promise<number>;
  /** Resolves once the queue is worked through (tests). */
  settled(): Promise<void>;
  dispose(): void;
}

/** The fanout waits for the AI up to this, not for it to succeed (§4.3). */
export const MAIL_FACT_AI_TIMEOUT_MS = 60_000;

/** An email's text goes to a model up to this length, and says when it was
 *  cut: a transactional email says what it has to near the top, and a longer
 *  one is too long for most models (and costs as much as it is long). */
export const MAIL_FACT_AI_BODY_MAX_CHARS = 50_000;

/** An email's text as a model gets it: canonical, as every reader reads it
 *  (§9), and at most `MAIL_FACT_AI_BODY_MAX_CHARS`. Read canonical from no
 *  more than four times that — a text that shows nothing in places is shorter
 *  read, and one of compatibility characters longer. */
export const bodyForModel = (raw: string): { readonly body_text: string; readonly body_truncated?: true } => {
  const read = MAIL_FACT_AI_BODY_MAX_CHARS * 4;
  const text = canonicalMailFactText(raw.slice(0, read));
  return text.length > MAIL_FACT_AI_BODY_MAX_CHARS || raw.length > read
    ? { body_text: text.slice(0, MAIL_FACT_AI_BODY_MAX_CHARS), body_truncated: true }
    : { body_text: text };
};
/** A job that failed this often for an unexpected reason settles without it. */
const MAX_ATTEMPTS = 3;

/** The call's kernel manifest: runtime-only, uncontracted, JSON out. */
export const MAIL_FACT_AI_MANIFEST: IngredientManifest = {
  slug: 'recued-mail-fact-ai',
  name: 'Mail facts: the AI pass',
  description: 'Fills the slots an AI-on mail template allows from one email — kernel-bundled, runtime-only.',
  author: KERNEL_AUTHOR,
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {
    'llm.system_prompt': null,
    'llm.prompt': null,
    'llm.output_format': 'json',
  },
  output: { result: 'body' },
};

// ────────────────────────────────────────────────────────────────
// The pool
// ────────────────────────────────────────────────────────────────

/** The layer a template's pool asks for; `null` when it cannot be honoured. */
export const mailFactAiLayer = (pool: MailFactPoolPolicy, byokAllowed: boolean): MailFactAiLayer | null => {
  if (pool === 'free_only') return 'free';
  if (pool === 'byok_only') return byokAllowed ? 'byok' : null;
  // free_then_byok: the resolver tries free first; without background BYOK, free only.
  return byokAllowed ? 'any' : 'free';
};

// ────────────────────────────────────────────────────────────────
// The request
// ────────────────────────────────────────────────────────────────

export const MAIL_FACT_AI_SYSTEM_PROMPT = [
  'You complete facts that rules read from one email. The email is the result of core.mail.get;',
  'what the rules read so far is the result of mail_fact.read, with the variables its type has.',
  '',
  'For each fact, fill only the slots it lists under "fill", from what this one email says.',
  'Never change a value the fact already has, never add or remove a fact, and use nothing but this email.',
  '',
  'A variable takes the value the email gives: a name or a code as written; a date as YYYY-MM-DD; a date and',
  'time as ISO 8601 (2026-09-26T14:30:00, with its offset when the email states one); an amount as',
  '{"amount":"12.50","currency":"EUR"}; and an enum variable one of the values listed for it. A slot starting',
  '"data." takes any JSON value, shaped as mail_fact.read\'s data_fields describe it when they name it.',
  'Answer null for a slot the email does not say.',
  '',
  // No alias-shaped example here: the privacy layer would reserve it as a
  // literal, and its own notice (pii_notice) already explains aliases.
  'A privacy alias (see pii_notice) stands for a real person or address: copy it exactly as written.',
  'The owner describes this kind of email in user_message.',
  '',
  'Answer with JSON only: {"facts":[{"position":0,"values":{"<slot>":<value or null>}}]}',
].join('\n');

/** What one waiting fact asks the AI for. */
export interface MailFactAiAsk {
  readonly fact: MailFact;
  /** The slots no pass read. */
  readonly fill: readonly string[];
}

const hasData = (data: unknown): boolean =>
  data !== null && typeof data === 'object' && Object.keys(data).length > 0;

/** The model input. The packet has the chat's shape, so the chat's privacy
 *  layer aliases it as it aliases a mail the chat reads: the email is a tool
 *  result, scanned against the whole warehouse's contacts; the facts read so
 *  far ride a second result, marked (`MAIL_FACT_PII_ENTITY`) so the people a
 *  template read — a lead's name, email and phone — are aliased, and with them
 *  every copy in the email; the owner's prompt is the user's message. A
 *  stranger the rules did not read, in free text, is not aliased: the layer
 *  aliases what it knows, it does not guess (§9). */
export const buildMailFactAiInput = (
  template: MailTemplate,
  spec: MailFactTypeSpec,
  ref: MailFactEmailRef,
  email: MailFactAiEmail,
  asks: readonly MailFactAiAsk[],
  layer: MailFactAiLayer,
  now: number,
): Record<string, unknown> => {
  const prompt = template.ai.enabled ? template.ai.prompt : '';
  const packet = {
    user_message: prompt,
    prior_tool_calls: [
      {
        tool_name: 'core.mail.get',
        status: 'ok',
        args: { slug: ref.slug, record_id: ref.record_id },
        result: {
          [PII_ENTITY_MARKER_KEY]: 'mail',
          from: email.from,
          to: email.to,
          cc: email.cc,
          subject: canonicalMailFactText(email.subject),
          date: email.date,
          ...bodyForModel(email.body_text),
        },
        started_at: now,
        completed_at: now,
      },
      {
        tool_name: 'mail_fact.read',
        status: 'ok',
        args: { type: spec.id },
        result: {
          type: spec.id,
          variables: mailFactTypeVariables(spec).map((variable) => ({
            name: variable.name,
            kind: variable.kind,
            ...(variable.values !== undefined ? { values: variable.values } : {}),
            ...(variable.description !== undefined ? { description: variable.description } : {}),
          })),
          // §3.2 — the data this kind of email names, with what each holds.
          ...(spec.data_fields !== undefined && spec.data_fields.length > 0 ? { data_fields: spec.data_fields } : {}),
          facts: asks.map(({ fact, fill }) => ({
            position: fact.position,
            // Marked, so the people a template read go out aliased (§9).
            read: {
              [PII_ENTITY_MARKER_KEY]: MAIL_FACT_PII_ENTITY,
              ...Object.fromEntries(Object.entries(fact.variables).filter(([, value]) => value !== null)),
            },
            ...(hasData(fact.data) ? { data: fact.data } : {}),
            fill,
          })),
        },
        started_at: now,
        completed_at: now,
      },
    ],
  };
  return {
    'llm.system_prompt': MAIL_FACT_AI_SYSTEM_PROMPT,
    'llm.prompt': JSON.stringify(packet),
    'llm.output_format': 'json',
    'llm.force_layer': layer,
  };
};

// ────────────────────────────────────────────────────────────────
// The answer
// ────────────────────────────────────────────────────────────────

/** A string, or any key or string inside a value, still in alias form after
 *  the answer was mapped back (§9): an alias the ledger never issued, or an
 *  aliased key, which mapping back leaves as it is.
 *  ⛔ The EXACT alias grammar, not the cheap pre-scan: that one also matches
 *  "PII." and `pii.csv`, which a faithful value can say, and refused them. */
export const holdsAlias = (value: unknown): boolean => holdsPiiAliasToken(value);

const ALIAS_NOT_RESTORED = 'alias not restored';

/** The answer's values for one fact, by position; `null` when the answer is
 *  not the shape asked for. */
export const answerValues = (body: unknown): Map<number, Record<string, unknown>> | null => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const facts = (body as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return null;
  const out = new Map<number, Record<string, unknown>>();
  for (const entry of facts) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { position, values } = entry as { position?: unknown; values?: unknown };
    if (typeof position !== 'number' || values === null || typeof values !== 'object' || Array.isArray(values)) continue;
    if (!out.has(position)) out.set(position, values as Record<string, unknown>);
  }
  return out;
};

/** One fact after the AI: only its empty slots, only with values valid for
 *  their kind, and finished as every pass finishes a fact (§9). */
export const fillFromAi = (
  spec: MailFactTypeSpec,
  fact: MailFact,
  fill: readonly string[],
  values: Readonly<Record<string, unknown>> | undefined,
  at: number,
): MailFactAiReading => {
  const variables: Record<string, MailFactValue | null> = { ...fact.variables };
  const passes: Record<string, MailFactPass> = { ...fact.passes };
  const data: Record<string, unknown> =
    fact.data !== null && typeof fact.data === 'object' && !Array.isArray(fact.data)
      ? structuredClone(fact.data as Record<string, unknown>)
      : {};
  const refused: MailFactRefusal[] = [...fact.refused];
  const specs = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable]));
  const filled: string[] = [];
  for (const slot of fill) {
    const value = values?.[slot];
    if (value === undefined || value === null) continue;
    if (holdsAlias(value)) {
      refused.push({ variable: slot, reason: ALIAS_NOT_RESTORED });
      continue;
    }
    if (slot.startsWith('data.')) {
      // Never over what another pass read, even on the way to the slot.
      if (mailFactDataPlaceTaken(data, slot.slice('data.'.length))) {
        refused.push({ variable: slot, reason: 'its place holds a value another pass read' });
        continue;
      }
      // Data passes as it came (ruling 14); the finishing refuses a card
      // number in it.
      setPath(data, slot.slice('data.'.length), value);
      passes[slot] = 'ai';
      filled.push(slot);
      continue;
    }
    const variable = specs.get(slot);
    if (variable === undefined) continue;
    // Money as the packet shows it: `{ amount, currency }`, amount with a point.
    const money = variable.kind === 'money' && value !== null && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as { amount?: unknown }).amount !== 'object'
      && typeof (value as { currency?: unknown }).currency === 'string'
      ? `${(value as { currency: string }).currency} ${String((value as { amount: unknown }).amount)}`
      : undefined;
    if (money === undefined && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      refused.push({ variable: slot, reason: 'the AI gave a value of the wrong shape' });
      continue;
    }
    // A JSON number is the number it is — its point a decimal point, never the
    // thousands mark an email's "1.125" can be; `1e-7` a number too.
    const result = variable.kind === 'number' && typeof value === 'number'
      ? normalizeJsonNumber(value)
      : normalizeValue(money ?? String(value), variable.kind, {
        ...(variable.values !== undefined ? { values: variable.values } : {}),
        variable: variable.name,
        // The object's amount has a decimal point, as the packet shows amounts;
        // an amount written as the email writes it is read as any is.
        ...(money !== undefined ? { decimalMark: '.' as const } : {}),
      });
    if (!result.ok) {
      refused.push({ variable: slot, reason: result.reason });
      continue;
    }
    variables[slot] = result.value;
    passes[slot] = 'ai';
    filled.push(slot);
  }
  // The AI's data alone may not take the fact over its cap: what the rules
  // read stays, and the AI's slots are refused with the reason.
  const aiData = filled.filter((slot) => slot.startsWith('data.'));
  let kept = data;
  if (aiData.length > 0 && Buffer.byteLength(JSON.stringify(data), 'utf8') > MAIL_FACT_DATA_MAX_BYTES) {
    kept = fact.data !== null && typeof fact.data === 'object' && !Array.isArray(fact.data)
      ? structuredClone(fact.data as Record<string, unknown>)
      : {};
    for (const slot of aiData) {
      delete passes[slot];
      filled.splice(filled.indexOf(slot), 1);
      refused.push({ variable: slot, reason: `the AI's data would take the fact over ${MAIL_FACT_DATA_MAX_BYTES / 1024} KB` });
    }
  }
  const reading = finishFact(spec, { position: fact.position, variables, passes, data: kept, refused });
  return {
    fact_id: fact.fact_id,
    reading: {
      variables: reading.variables,
      passes: reading.passes,
      data: reading.data,
      refused: reading.refused,
      missing: reading.missing,
      complete: reading.complete,
    },
    ai: { state: 'read', filled, at },
  };
};

/** Why the AI did not answer, in words for the facts list. */
export const mailFactAiFailure = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'AI_LLM_UNAVAILABLE':
      return 'no model was available in its pool';
    case 'AI_TOKEN_BUDGET_EXCEEDED': {
      // The providers raise this for an input the model cannot take, too.
      const status = (error as { details?: { status?: unknown } } | null)?.details?.status;
      const message = error instanceof Error ? error.message : '';
      return status === 413 || /input too large|context/i.test(message)
        ? 'the email was too long for the model'
        : "the day's AI budget is spent";
    }
    case 'AI_TIMEOUT':
      return 'the AI took too long';
    case 'AI_MODEL_REFUSED':
      return 'the model refused';
    case 'AI_OUTPUT_INVALID':
    case 'AI_RESPONSE_PARSE_FAILED':
    case 'AI_RESPONSE_VALIDATION_FAILED':
      return "the AI's answer could not be read";
    default:
      break;
  }
  // The chat's privacy layer raises this for anything that failed before the
  // model was called (`privateAiCall`): no call was made.
  if (code === 'chat_pii_privacy_failed') {
    return 'the privacy layer could not protect this email, so no call was made';
  }
  const message = error instanceof Error ? error.message : String(error);
  return `the AI failed: ${message.slice(0, 200)}`;
};

// ────────────────────────────────────────────────────────────────
// Reading the stored copy
// ────────────────────────────────────────────────────────────────

const hotStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The stored copy of an email across the mailboxes, as the AI reads it. */
export const readMailFactAiEmail = (
  deps: StoredEmailDeps & { readonly mailboxes: () => readonly MailCollection[] },
) => async (ref: MailFactEmailRef): Promise<MailFactAiEmail | null> => {
  const box = deps.mailboxes().find((candidate) => candidate.slug === ref.slug);
  const record = box?.get(ref.record_id) ?? null;
  if (record === null) return null;
  const email = await storedCopyEmail(deps, record);
  return {
    from: email.from_address,
    to: hotStrings(record.hot_fields.to),
    cc: hotStrings(record.hot_fields.cc),
    subject: email.subject,
    date: new Date(record.received_at).toISOString(),
    body_text: email.body_text,
  };
};

// ────────────────────────────────────────────────────────────────
// The runner
// ────────────────────────────────────────────────────────────────

/** A fact's reading as it stands, for a fact the AI leaves as the rules read it. */
const asRead = (fact: MailFact): MailFactAiReading['reading'] => ({
  variables: fact.variables,
  passes: fact.passes,
  data: fact.data !== null && typeof fact.data === 'object' && !Array.isArray(fact.data)
    ? fact.data as Readonly<Record<string, unknown>>
    : null,
  refused: fact.refused,
  missing: fact.missing,
  complete: fact.complete,
});

export const createMailFactAiRunner = (deps: MailFactAiDeps): MailFactAiRunner => {
  const { store } = deps;
  const timeout_ms = deps.timeoutMs ?? MAIL_FACT_AI_TIMEOUT_MS;
  let active = false;
  let disposed = false;
  let current: Promise<void> = Promise.resolve();

  /** Waits for an email's news, each counting the events its answers told. */
  const waiters = new Set<{ readonly email: MailFactEmailRef; told: number; readonly resolve: (told: number) => void }>();
  let recheck: ReturnType<typeof setInterval> | null = null;
  /** Where an email is now: a move gives it a new id, and its call goes with
   *  it (§6.4). A wait follows it there. */
  const whereNow = (email: MailFactEmailRef): MailFactEmailRef => store.emailMovedTo(email) ?? email;
  const holdsNews = (email: MailFactEmailRef): boolean => store.aiJobsForEmail(whereNow(email)).some((job) => job.may_trigger);
  /** Ends each wait whose email no call holding news waits on, and every
   *  wait once the runner is disposed. Never throws: it runs on a timer. */
  const wake = (): void => {
    for (const waiter of [...waiters]) {
      let waits: boolean;
      try {
        waits = !disposed && holdsNews(waiter.email);
      } catch {
        waits = false; // the store cannot say: a wait never outlives it
      }
      if (waits) continue;
      waiters.delete(waiter);
      waiter.resolve(waiter.told);
    }
    if (waiters.size === 0 && recheck !== null) {
      clearInterval(recheck);
      recheck = null;
    }
  };

  const typeSpecOf = (type: string): MailFactTypeSpec | undefined =>
    getMailFactBuiltinType(type) ?? store.getCustomType(type) ?? undefined;

  /** `'wait'` when the job's mailbox is not live yet: it stays queued. */
  const runJob = async (job: MailFactAiJob): Promise<'wait' | void> => {
    if (deps.mailboxLive?.(job.email.slug) === false) return 'wait';
    const facts = store.factsForEmail(job.email)
      .filter((fact) => fact.template_id === job.template_id && fact.ai?.state === 'waiting');
    /** Places the readings `read` makes — made after any wait for room, so
     *  they are read as the template is when they are placed. */
    const settle = async (read: () => readonly MailFactAiReading[]): Promise<void> => {
      // Placed, the facts may start recipes: wait for room first when the job
      // (as it is stored now — a backfill may have promoted it) carries news.
      if (facts.length > 0 && deps.triggerRoom !== undefined && store.getAiJob(job.job_id)?.may_trigger === true) {
        await deps.triggerRoom();
      }
      const result = deps.writer.applyAi(job, read());
      const answered = whereNow(job.email);
      for (const waiter of waiters) {
        const waited = whereNow(waiter.email);
        if (waited.slug === answered.slug && waited.record_id === answered.record_id) waiter.told += result.events;
      }
    };
    // Nothing waits on it: a newer reading of the email replaced its facts.
    if (facts.length === 0) {
      await settle(() => []);
      return;
    }
    const notRead = (reason: string): Promise<void> =>
      settle(() => facts.map((fact) => ({ fact_id: fact.fact_id, reading: asRead(fact), ai: { state: 'not_read', reason, at: deps.now() } })));
    if (job.attempts >= MAX_ATTEMPTS) return notRead(`the AI pass failed ${MAX_ATTEMPTS} times`);
    store.bumpAiJobAttempts(job.job_id);

    /** What the call is made with, read now — or why there is none. Read
     *  before the email and again once it is read: the owner can switch the
     *  template, its AI or background AI off while it is read. */
    const ready = () => {
      const template = store.getTemplate(job.template_id);
      if (template === null) return 'its template was deleted';
      // Switched off: it reads no mail, so it sends none to a model either. The
      // facts go on with what the rules read, and start nothing (`applyAi`).
      if (!template.active) return 'its template was switched off';
      if (!template.ai.enabled) return "its template's AI was switched off";
      const spec = typeSpecOf(template.type);
      if (spec === undefined) return 'its type is no longer known';
      if (deps.isPaused()) return 'background AI is paused';
      if (deps.budgetSpent?.() === true) return "the day's AI budget for background work is spent (Settings → AI)";
      const layer = mailFactAiLayer(template.ai.pool, deps.byokAllowed());
      if (layer === null) return 'its pool is your own keys only, and background AI may not use them (Settings → AI)';
      const slots = template.ai.slots;
      const asks = facts.map((fact) => ({ fact, fill: mailFactEmptyAiSlots(slots, fact) }));
      return { template, spec, layer, asks };
    };
    /** The template changed and nothing is left to fill. */
    const nothingToFill = (asks: ReadonlyArray<{ fact: MailFact; fill: readonly string[] }>): boolean =>
      asks.every((ask) => ask.fill.length === 0);
    const filledNothing = (asks: ReadonlyArray<{ fact: MailFact }>): Promise<void> =>
      settle(() => asks.map(({ fact }) => ({ fact_id: fact.fact_id, reading: asRead(fact), ai: { state: 'read', filled: [], at: deps.now() } })));

    const first = ready();
    if (typeof first === 'string') return notRead(first);
    if (nothingToFill(first.asks)) return filledNothing(first.asks);
    const email = await deps.readEmail(job.email);
    if (email === null) return notRead('its email is no longer stored');
    // A newer reading of the email replaced this job while it was read: that
    // job reads it, and this one sends nothing.
    if (store.getAiJob(job.job_id) === null) return;
    const now = ready();
    if (typeof now === 'string') return notRead(now);
    if (nothingToFill(now.asks)) return filledNothing(now.asks);
    const { template, spec, layer, asks } = now;

    let body: unknown;
    try {
      body = await deps.call(buildMailFactAiInput(template, spec, job.email, email, asks, layer, deps.now()), { timeout_ms });
    } catch (error) {
      return notRead(mailFactAiFailure(error));
    }
    const answer = answerValues(body);
    if (answer === null) return notRead("the AI's answer could not be read");
    const at = deps.now();
    // Taken as the template's AI is when it is placed — the owner can take a
    // slot from it, or switch it off, while the call runs or the answer waits
    // for room: what it may no longer fill is not taken (§4.3). The writer
    // reads the switch again as it commits.
    await settle(() => {
      const current = store.getTemplate(job.template_id);
      const may = new Set(current?.ai.enabled === true ? current.ai.slots : []);
      return asks.map(({ fact, fill }) => fillFromAi(spec, fact, fill.filter((slot) => may.has(slot)), answer.get(fact.position), at));
    });
  };

  /** Mailboxes not live on this run: their jobs wait for a later kick. */
  const loop = async (waiting: Set<string>): Promise<boolean> => {
    // After the commit that queued the job, never inside it.
    await Promise.resolve();
    for (;;) {
      if (disposed) return true;
      const job = store.nextAiJob(waiting);
      if (job === null) return true;
      try {
        if (await runJob(job) === 'wait') waiting.add(job.email.slug);
        wake();
      } catch (error) {
        // An unexpected failure: stop, and let the next kick retry it. Its
        // attempts are counted, so it settles without the AI in the end.
        deps.logger?.warn('mail fact: the AI pass failed', { error, email: job.email, template_id: job.template_id });
        return false;
      }
    }
  };

  // An unexpected failure stops the run; without a retry the queue would wait
  // for the next email or restart.
  const firstRetry = deps.retryDelayMs ?? 30_000;
  let retryDelay = firstRetry;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const kick = (): void => {
    if (active || disposed) return;
    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
    active = true;
    const waiting = new Set<string>();
    current = loop(waiting).then((clean) => {
      active = false;
      wake();
      if (!clean && !disposed) {
        retry = setTimeout(() => {
          retry = null;
          kick();
        }, retryDelay);
        retry.unref?.();
        retryDelay = Math.min(retryDelay * 2, 600_000);
        return;
      }
      retryDelay = firstRetry;
      // A job queued between the last look and now would wait for the next
      // kick; look once more — past the mailboxes still not live.
      if (clean && !disposed && store.countAiJobs(waiting) > 0) kick();
    }, (error: unknown) => {
      active = false;
      deps.logger?.warn('mail fact: the AI pass stopped', { error });
    });
  };

  return {
    kick,
    untilSettled: (email) => new Promise<number>((resolve) => {
      waiters.add({ email, told: 0, resolve });
      // A call can go without the runner — its email deleted: look again now and then.
      if (recheck === null) {
        recheck = setInterval(wake, deps.settleRecheckMs ?? 1_000);
        recheck.unref?.();
      }
      wake();
      kick();
    }),
    settled: async () => {
      // `current` is replaced when a kick chains another run; wait for the last.
      for (;;) {
        const seen = current;
        await seen;
        if (current === seen && !active) return;
      }
    },
    dispose: () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      wake();
    },
  };
};
