/** D-343 slice 1 (ruling 15) — a mail fact the chat closes by making the record the agenda shows
 *  it through. Only mail closes a fact itself, so the fact stays evidence; what the owner says
 *  about it ("I paid the City Water bill") becomes the fact's record, already closed:
 *  - a bill's commitment to pay it, kept or cancelled;
 *  - a reservation's booking, completed, a no-show or cancelled;
 *  - anything else, a task ticked off.
 *  The agenda then shows the fact through that record (ruling 15), so it leaves the agenda.
 *
 *  ⛔ A bill's and a reservation's records take the keys the Bills and Bookings packs make theirs
 *  with (`mail-fact-bill:` / `mail-fact-booking:`), and the packs' words, so a pack installed
 *  later that reads the fact gets this record back instead of adding a second. A key whose record
 *  the owner deleted is not reused: the record is made without it. */
import type Database from 'better-sqlite3';
import {
  calendarDayMs, COMMITMENT_AMOUNT_REGEX, COMMITMENT_CURRENCY_REGEX, getMailFactBuiltinType, workEntityIdFromIdempotencyKey,
  zonedWallClockToEpochMs, type IdempotentCreateKind, type MailFactThing, type MonetaryValue,
} from '@recued/contracts';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import { BOOKING_TABLE, COMMITMENT_TABLE, NOTE_TABLE, TASK_TABLE, unambiguousDateMs } from '../storage/work-entity-store.js';
import type { createWorkEntityDispatchers } from '../work-entity-ingredients.js';

/** How the owner says a fact ended. */
export type MailFactCloseTo = 'done' | 'cancelled' | 'no_show';
export interface MailFactRecord { readonly kind: 'task' | 'note' | 'commitment' | 'booking'; readonly id: string; readonly title: string }
/** A fact as the chat sees it: what the agenda calls it, whether its own mail closed it, the record
 *  made from it, and how it can be closed. */
export interface MailFactView {
  readonly type: string;
  readonly title: string;
  readonly closed: boolean;
  readonly record: MailFactRecord | null;
  readonly closes: readonly MailFactCloseTo[];
}
export interface MailFactClose {
  read(thing_id: string): MailFactView | null;
  /** `at` is when a bill was paid or cancelled, or a task done; a reservation's times without a
   *  zone are on `time_zone`'s clock. */
  close(input: { thing_id: string; to: MailFactCloseTo; at: number; time_zone?: string }): Promise<MailFactRecord>;
}

const CLOSED_STATES = new Set(['cancelled', 'paid', 'delivered', 'returned', 'refund_issued']);
const LABELS = ['issuer', 'merchant', 'provider', 'carrier'];
const KIND_WORDS: Readonly<Record<string, string>> = {
  lodging: 'stay', transport: 'trip', event: 'tickets', dining: 'table', appointment: 'appointment', car: 'car rental',
};
const HOUR = 3_600_000;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
/** As the store keeps money: a decimal at scale 2 in an ISO currency, else none. */
const money = (value: unknown): MonetaryValue | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const { amount, currency } = value as Record<string, unknown>;
  return typeof amount === 'string' && COMMITMENT_AMOUNT_REGEX.test(amount) && typeof currency === 'string' && COMMITMENT_CURRENCY_REGEX.test(currency)
    ? { amount, currency } : undefined;
};
/** When a reservation starts or ends: a time with its zone as written; a time without one, or a
 *  day from its midnight, on the owner's clock. */
const momentOf = (value: unknown, zone: string): { at: number; day: boolean } | undefined => {
  const written = text(value);
  if (written === undefined) return undefined;
  const local = zonedWallClockToEpochMs(written, zone);
  if (local !== null) return { at: local, day: written.length === 10 };
  const at = unambiguousDateMs(written);
  return at === null ? undefined : { at, day: false };
};

export const createMailFactClose = (deps: { db: Database.Database; mailFacts: MailFactStore; dispatchers: ReturnType<typeof createWorkEntityDispatchers> }): MailFactClose => {
  const tables = { task: TASK_TABLE, note: NOTE_TABLE, commitment: COMMITMENT_TABLE, booking: BOOKING_TABLE } as const;
  // The agenda's own link (`sources.ts`): a live record whose source names the fact.
  const linked = deps.db.prepare(Object.entries(tables).map(([kind, table]) =>
    `SELECT '${kind}' AS kind, id, ${kind === 'commitment' ? 'statement' : 'title'} AS title FROM ${table}
      WHERE deleted_at IS NULL AND json_valid(source_extension_blob) AND json_extract(source_extension_blob,'$.kind')='mail_fact'
      AND json_extract(source_extension_blob,'$.thing_id')=?`).join(' UNION ALL '));
  const recordOf = (thing_id: string): MailFactRecord | null =>
    (linked.get(thing_id, thing_id, thing_id, thing_id) as MailFactRecord | undefined) ?? null;
  const gone = Object.fromEntries(Object.entries(tables).map(([kind, table]) =>
    [kind, deps.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND (deleted_at IS NOT NULL OR sync_state<>'live')`)]));
  /** The key a record of the fact is made under, unless the record it names was deleted. */
  const keyFor = (kind: IdempotentCreateKind & keyof typeof tables, prefix: string, thing_id: string): { idempotency_key: string } | Record<string, never> => {
    const key = `${prefix}:${thing_id}`.replaceAll('_', '-');
    const id = workEntityIdFromIdempotencyKey(kind, key);
    return id !== null && gone[kind]!.get(id) === undefined ? { idempotency_key: key } : {};
  };
  /** As the agenda heads it ("Bill: Acme Power"). */
  const titleOf = (thing: MailFactThing): string => {
    const spaced = thing.type.replace(/^custom_/u, '').replaceAll('_', ' ').trim();
    const name = getMailFactBuiltinType(thing.type)?.name ?? deps.mailFacts.getCustomType(thing.type)?.name
      ?? (spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : thing.type);
    const label = LABELS.map((field) => text(thing.variables[field])).find((value) => value !== undefined);
    return label === undefined ? name : `${name}: ${label}`;
  };
  const closesOf = (type: string): readonly MailFactCloseTo[] =>
    type === 'bill' ? ['done', 'cancelled'] : type === 'reservation' ? ['done', 'cancelled', 'no_show'] : type === 'owner_request' ? [] : ['done'];
  return {
    read(thing_id) {
      const thing = deps.mailFacts.getThing(thing_id);
      if (!thing) return null;
      const state = thing.variables.state;
      return { type: thing.type, title: titleOf(thing), closed: typeof state === 'string' && CLOSED_STATES.has(state),
        record: recordOf(thing_id), closes: closesOf(thing.type) };
    },
    async close({ thing_id, to, at, time_zone }) {
      const thing = deps.mailFacts.getThing(thing_id);
      if (!thing) throw new Error(`There is no mail fact ${thing_id}`);
      if (!closesOf(thing.type).includes(to)) throw new Error(`A ${thing.type} does not close as ${to}`);
      const v = thing.variables;
      const link = { kind: 'mail_fact', fact_type: thing.type, thing_id };
      if (thing.type === 'bill') {
        // The Bills pack's words: "Pay City Water invoice 4471 (82.40 EUR)".
        const amount = text((v.amount_due as Record<string, unknown> | null)?.amount); const currency = text((v.amount_due as Record<string, unknown> | null)?.currency);
        const reference = text(v.invoice_number) !== undefined ? ` invoice ${text(v.invoice_number)}` : text(v.period) !== undefined ? ` for ${text(v.period)}` : '';
        const statement = `Pay ${text(v.issuer) ?? titleOf(thing)}${reference}${amount && currency ? ` (${amount} ${currency})` : ''}`.slice(0, 500);
        const due = typeof v.due_at === 'string' ? calendarDayMs(v.due_at) : null; const owed = money(v.amount_due);
        const { commitment } = await deps.dispatchers.commitmentCreate({ direction: 'outbound', derivation: 'mail_extracted', statement,
          expiry_policy: 'escalate_overdue', source_extension_blob: link, ...keyFor('commitment', 'mail-fact-bill', thing_id),
          ...(due !== null ? { promised_for_at: due } : {}), ...(owed ? { monetary_value: owed } : {}) });
        if (commitment.lifecycle_state === 'pending') {
          if (to === 'cancelled') await deps.dispatchers.commitmentCancel({ id: commitment.id, cancelled_at: at });
          else await deps.dispatchers.commitmentFulfill({ id: commitment.id, fulfilled_at: at });
        }
        return { kind: 'commitment', id: commitment.id, title: commitment.statement };
      }
      if (thing.type === 'reservation') {
        // The Bookings pack's words and slot: "Hotel Lumen stay for 2 (QX7Y) — Lisbon", and an end
        // it does not know a day or two hours after the start.
        const provider = text(v.provider); const code = text(v.confirmation_code); const location = text(v.location);
        const party = typeof v.party_size === 'number' || text(v.party_size) !== undefined ? ` for ${String(v.party_size).trim()}` : '';
        const title = provider === undefined ? titleOf(thing)
          : `${provider} ${KIND_WORDS[text(v.kind) ?? ''] ?? 'booking'}${party}${code ? ` (${code})` : ''}${location && location !== provider ? ` — ${location}` : ''}`.slice(0, 200);
        const zone = time_zone ?? 'UTC';
        const start = momentOf(v.starts_at, zone); const end = momentOf(v.ends_at, zone);
        const slot = start === undefined ? {} : { slot_start_at: start.at,
          slot_end_at: end !== undefined && end.at > start.at ? end.at : start.at + (start.day ? 24 : 2) * HOUR };
        const lifecycle_state = to === 'done' ? 'completed' : to;
        const total = money(v.total);
        const { booking } = await deps.dispatchers.bookingCreate({ title, lifecycle_state, source_extension_blob: link,
          ...keyFor('booking', 'mail-fact-booking', thing_id), ...slot, ...(total ? { monetary_value: total } : {}) });
        if (booking.lifecycle_state !== lifecycle_state) await deps.dispatchers.bookingUpdate({ id: booking.id, lifecycle_state });
        return { kind: 'booking', id: booking.id, title: booking.title };
      }
      const { task } = await deps.dispatchers.taskCreate({ title: titleOf(thing), source_extension_blob: link, ...keyFor('task', 'mail-fact-task', thing_id) });
      if (!task.done) await deps.dispatchers.taskMarkDone({ id: task.id, done: true, completed_at: at });
      return { kind: 'task', id: task.id, title: task.title };
    },
  };
};
