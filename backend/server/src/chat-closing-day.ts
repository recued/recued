/** D-343 slice 3 (§3.3, rulings 5, 6 and 12) — the closing instructions. The owner closes a day by
 *  replying to their Agenda (D-338) or their daily stream (D-340), or to their evening notice (slice 4),
 *  quoting it. That turn
 *  carries how to close the day the notice is about, which may be days ago (ruling 5): record what
 *  they report in one `episode.record` call for that day (ruling 18), tick off what has its own
 *  done, ask about each item they left out (ruling 6), and say what was recorded.
 *
 *  ⛔ ONLY ON THE TURN THAT QUOTES ONE. In the system prompt it would ride every turn of every
 *  conversation for a ritual many owners never use; here it rides the reply that closes a day and
 *  costs nothing otherwise (ruling 3). The notice's title says which day: the host reads it on the
 *  turn's clock, so the model is given the date rather than left to work out a year.
 *  ⚠ Model-facing — `chat-prompt-optimization-log.md`. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The notices a day is closed from, as their first line names them: the Agenda, the evening notice,
 *  and since D-340 slice 2 the daily and weekly streams (ruling 12: "Your day", "Your week"). */
const TITLE = /^(?:Agenda|Close the day|Your day|Your week) · (.+)$/u;
/** A day as their titles write it (`Intl` en-GB: "Thu 6 Nov"; September is "Sept" in newer ICU). */
const DAY_NAME = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)$/u;

const pad = (value: number): string => String(value).padStart(2, '0');

/** The JSON object a quoted reply leads the model's message with (`{"reply_to": …, "message": …}`).
 *  A file's marker may follow it, so it is read up to its own closing brace. */
const leadingObject = (text: string): Record<string, unknown> | undefined => {
  if (!text.startsWith('{')) return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && (depth -= 1) === 0) {
      try { const value: unknown = JSON.parse(text.slice(0, i + 1)); return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
      catch { return undefined; }
    }
  }
  return undefined;
};

/** A day named as the notices name it ("Thu 6 Nov"): the one, in today's year or either beside it,
 *  that falls on its weekday. A date moves a weekday or two a year, so at most one does;
 *  `undefined` for a name no day fits. */
const dayNamed = (name: string, today: string): string | undefined => {
  const parts = DAY_NAME.exec(name.trim());
  if (parts === null) return undefined;
  const month = MONTHS.indexOf(parts[3]!.slice(0, 3)) + 1; const date = Number(parts[2]);
  const year = Number(today.slice(0, 4));
  return [year - 1, year, year + 1].map((y) => `${y}-${pad(month)}-${pad(date)}`).find((day) => {
    const time = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day && WEEKDAYS[new Date(time).getUTCDay()] === parts[1];
  });
};

/** `Re:` as mail clients write it (English, German, Nordic, Dutch, Portuguese; a count like `Re[2]:`). */
const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw|res)\s*(?:\[\d+\])?\s*:\s*/iu;

/** The notice an email reply answers, read off its subject ("Re: Your day · Fri 13 Nov [#ask-…]"):
 *  the title of an Agenda, an evening notice or a stream, as `quotedClosingDay` reads it, or
 *  `undefined`. Only a reply counts: a subject with no reply prefix is the owner writing to
 *  themselves, not answering a notice. A repeat's "Repeat:" and a reminder ask's tag are dropped. */
export const repliedClosingTitle = (subject: string): string | undefined => {
  let rest = subject; let replied = false;
  while (REPLY_PREFIX.test(rest)) { rest = rest.replace(REPLY_PREFIX, ''); replied = true; }
  if (!replied) return undefined;
  const title = rest.replace(/^Repeat:\s*/u, '').replace(/\s*\[#ask-[^\]\s]+\]\s*$/u, '').trim();
  return TITLE.test(title) ? title : undefined;
};

/** A quoted notice a day is closed from: its title, and the days it is about. D-340 slice 3 —
 *  `reminders`: a daily stream that carried reminders, which the owner answers separately. */
export interface ClosingQuote { readonly title: string; readonly from: string; readonly to: string; readonly reminders?: true }
/** D-343 slice 4 — the evening notice ("Close the day · …"), which also asks about the pursuits the
 *  owner marked "Ask me in the evening"; the Agenda does not. */
export const isEveningNotice = (quote: ClosingQuote): boolean => quote.title.startsWith('Close the day · ');

/** The Agenda or evening notice a turn's message quotes, with its days on the turn's clock
 *  (`today`); `undefined` when the message quotes no such notice. */
export const quotedClosingDay = (userMessage: string, today: string): ClosingQuote | undefined => {
  const quote = leadingObject(userMessage)?.reply_to;
  if (quote === null || typeof quote !== 'object' || (quote as { role?: unknown }).role !== 'notice') return undefined;
  const text = (quote as { text?: unknown }).text;
  if (typeof text !== 'string') return undefined;
  const title = text.split('\n', 1)[0]!.trim();
  const named = TITLE.exec(title);
  if (named === null) return undefined;
  const [first, last = first] = named[1]!.split(' to ');
  const from = dayNamed(first!, today); const to = dayNamed(last!, today);
  // D-340 slice 3 — the stream's "Reminders" heading, a line of its own: an item's line has its time.
  const reminders = text.split('\n').slice(1).some((line) => line.trim() === 'Reminders');
  return from !== undefined && to !== undefined && from <= to ? { title, from, to, ...(reminders ? { reminders: true as const } : {}) } : undefined;
};

/** An item on the quoted day's agenda, as the note lists it: what the owner saw it called, and the
 *  ref a record cites it by. */
export interface ClosingItem {
  readonly title: string; readonly ref: { readonly collection: string; readonly id: string; readonly field?: string };
  /** D-343 (2026-11-15) — already recorded for the day, from any conversation, as done or skipped. */
  readonly recorded?: 'done' | 'skipped';
}
/** D-343 (2026-11-15) — a record already kept for the day that cites none of its items ("Went for a
 *  walk"), from any conversation. */
export interface RecordedLine { readonly title: string; readonly outcome: 'done' | 'skipped' }
/** A day's items as a closing note lists them: each item, and what was already recorded without one. */
export type ClosingDay = readonly ClosingItem[] & { readonly recorded_other?: readonly RecordedLine[] };

/** D-343 (2026-11-15) — a day's items with what is already recorded for it, whichever conversation
 *  recorded it (two channels closing one day): an item a record cites is marked, and a record that
 *  cites no item is listed beside them. */
export const withRecorded = (items: readonly ClosingItem[],
  recorded: ReadonlyArray<{ title: string; outcome: 'done' | 'skipped'; ref?: { collection: string; id: string; field?: string } }>): ClosingDay => {
  const key = (ref: { collection: string; id: string; field?: string }): string => JSON.stringify([ref.collection, ref.id, ref.field ?? null]);
  const byItem = new Map<string, 'done' | 'skipped'>();
  const other: RecordedLine[] = [];
  const known = new Set(items.map(item => key(item.ref)));
  for (const record of recorded) {
    if (record.ref !== undefined && known.has(key(record.ref))) byItem.set(key(record.ref), record.outcome);
    else other.push({ title: record.title, outcome: record.outcome });
  }
  const marked = items.map(item => byItem.has(key(item.ref)) ? { ...item, recorded: byItem.get(key(item.ref))! } : item);
  return other.length > 0 ? Object.assign(marked, { recorded_other: other }) : marked;
};
/** At most `CLOSING_ITEMS_MAX` items, keeping what is recorded with no item. */
const capItems = (items: readonly ClosingItem[] | undefined): ClosingDay | undefined => {
  if (items === undefined) return undefined;
  const other = (items as ClosingDay).recorded_other;
  const capped = items.slice(0, CLOSING_ITEMS_MAX);
  return other !== undefined && other.length > 0 ? Object.assign(capped, { recorded_other: other }) : capped;
};
const anyRecorded = (items: readonly ClosingItem[] | undefined): boolean =>
  items !== undefined && (items.some(item => item.recorded !== undefined) || ((items as ClosingDay).recorded_other?.length ?? 0) > 0);
/** The most items a note lists; the Agenda shows at most a dozen a day. */
export const CLOSING_ITEMS_MAX = 20;

/** How to close the day, or days, a quoted notice is about: a line for the model's copy of the
 *  message, as the email door's note is (`mailChatMailNote`). Given the day's items, it lists each
 *  with its ref, so the model cites them and sees what was left out without reading the day
 *  itself; without them, it reads the day first. */
export const closingDayNote = (quote: ClosingQuote, items?: readonly ClosingItem[]): string => {
  const one = quote.from === quote.to;
  const days = one ? quote.from : `${quote.from} to ${quote.to}`;
  const listed = items !== undefined && items.length > 0;
  return `\n[This replies to their notice “${quote.title}”, about ${days}.`
    + (listed ? ` ${itemList(items)}\n` : ' ')
    + `If the message tells you how ${one ? 'that day' : 'those days'} went, close ${one ? 'it' : 'each'}:\n`
    + numbered([
      ...(listed ? [] : [`Read ${one ? 'the day' : 'each day'} with situation.query (time ${one ? quote.from : 'that day'}) for each item's ref.`]),
      ...closingSteps(quote, listed, true, anyRecorded(items)),
    ])
    + ']';
};

/** D-343 (the owner, 2026-11-14: "it can ask about the missing pieces first, then propose the
 *  approval all together") — the turn after the one that asked about what they left out. Their
 *  answer quotes no notice, so it carries the notice and its items again. */
export const closingFollowUpNote = (quote: ClosingQuote, items?: readonly ClosingItem[], proposed = false): string => {
  const one = quote.from === quote.to;
  const listed = items !== undefined && items.length > 0;
  const days = one ? quote.from : `${quote.from} to ${quote.to}`;
  // D-343 — the record is proposed and waits for their yes: a change to it is the whole day again,
  // which replaces the one waiting. Without the items here, a changed record lost its refs (live).
  if (proposed) {
    return `\n[The record of their notice “${quote.title}”, about ${days}, waits for their approval. If this changes what to record, `
      + `propose the whole day again in one episode.record call${one ? ` with day ${quote.from}` : ' per day'}: it replaces the one waiting.`
      + (listed ? ` ${itemList(items)}\n` : ' ')
      + 'Each item done or skipped, in their words, with its ref; anything else they did, with no item. '
      + 'That call also ticks off each task recorded as done: do not call work.update for it.]';
  }
  return `\n[This may answer what you asked about their notice “${quote.title}”, about ${days}, `
    + 'which is not recorded yet.'
    + (listed ? ` ${itemList(items)}\n` : ' ')
    + `Once you know how each item went, close ${one ? 'it' : 'each day'}:\n`
    + `${numbered(closingSteps(quote, listed, false, anyRecorded(items)))}]`;
};

const itemList = (items: readonly ClosingItem[]): string => `Its items, each with its ref:\n${items.map((item) => `- ${item.title} ${JSON.stringify({
  collection: item.ref.collection, id: item.ref.id, ...(item.ref.field !== undefined ? { field: item.ref.field } : {}) })}`
  + (item.recorded !== undefined ? ` (already recorded: ${item.recorded})` : '')).join('\n')}`
  + (((items as ClosingDay).recorded_other?.length ?? 0) > 0
    ? `\nAlready recorded with no item: ${(items as ClosingDay).recorded_other!.map(line => `${line.title} (${line.outcome})`).join('; ')}` : '');
/** D-343 (2026-11-15) — the step a day already partly recorded (from another conversation) adds. */
const RECORDED_STEP = 'What is already recorded (marked so, or listed as already_recorded) was recorded earlier, maybe from another conversation: do not ask about it, '
  + 'and record it again only if they now say something different (a record of the same item replaces it). '
  + 'Do not record again what they already said in other words.';
const numbered = (steps: readonly string[]): string => steps.map((step, n) => `${n + 1}. ${step}`).join('\n');
/** Ask first, then one record that also ticks off what they did: the day is one approval. Before
 *  2026-11-14 it was record first, tick off after, then ask, so a partial reply cost the owner a
 *  record, a tick-off and a second record to approve. */
const closingSteps = (quote: ClosingQuote, listed: boolean | 'result', first: boolean, recorded = false): string[] => {
  const one = quote.from === quote.to;
  const where = listed === 'result' ? 'in this result' : listed ? 'above' : 'on the notice';
  return [
    ...(recorded ? [RECORDED_STEP] : []),
    // D-340 slice 3 — a stream's reminders are not the day's items: each has its own answers. Without
    // this, 3 of 3 live closes asked whether to record a reminder due next month as skipped.
    ...(first ? [`If they did not mention every item ${where}${quote.reminders ? ' (not the notice\'s Reminders, which they answer separately)' : ''}, `
      + 'first ask about each one they left out (did they do it, skip it, or should it be left out?) and change nothing until they answer.']
      : ['If an item is still unanswered, ask about it and change nothing yet.']),
    `Then record ${one ? 'the day' : 'each day'} in one episode.record call ${one ? `with day ${quote.from}` : 'per day (ask which day if they do not say)'}: `
      + `each item done or skipped, in their words without "did" or "didn't" (the outcome says it), with its ref${listed === true ? ' above' : listed === 'result' ? ' from this result' : ''}; anything else they did, with no item; nothing for an item they said to leave out.`,
    'That call also ticks off each task recorded as done: do not call work.update for it.',
    'Say what you recorded.',
  ];
};

/** D-343 (the owner, 2026-11-14: "there should be a way for model to trigger the day closing") — how
 *  to close a day the user brings up without replying to its notice, as `situation.query` with
 *  `close: true` returns it beside the day's items. */
export const closingToolSteps = (day: string, recorded = false): string =>
  `To close ${day} with the user: ${numbered(closingSteps({ title: '', from: day, to: day }, 'result', true, recorded))}`;

/** D-343 (2026-11-14) — the days whose closing a conversation is in the middle of: its notice was
 *  quoted, and no record was proposed yet (the owner was asked what they left out). Kept in memory
 *  for a day; after a restart the next answer gets no note, and the model has the conversation. */
export const CLOSING_OPEN_MS = 24 * 3_600_000;
export interface OpenClosing {
  readonly quote: ClosingQuote; readonly items?: readonly ClosingItem[]; readonly follow_ups?: number;
  /** Its record is proposed: it stays open only while that record waits for the owner. */
  readonly proposed?: true;
  /** D-343 (2026-11-15) — a reply to today's morning notice ("Your day", the Agenda), most often a
   *  plan for the day: it stays a closing only once a record is proposed. */
  readonly tentative?: true;
}
/** The turns after the ask a note rides on: their answer, and one more if they asked something back. */
export const CLOSING_FOLLOW_UPS = 2;
export const createOpenClosings = (now: () => number = Date.now,
  /** Whether a record of the closing's day still waits for the owner in that conversation. */
  recordWaits?: (session_id: string, quote: ClosingQuote) => Promise<boolean>) => {
  const open = new Map<string, OpenClosing & { at: number }>();
  return {
    /** The note for a turn's message: a reply to a notice, or the turn after one that asked. */
    async begin(session_id: string, userMessage: string, today: string,
      itemsOf?: (quote: ClosingQuote) => Promise<readonly ClosingItem[] | undefined>): Promise<{ line: string; closing?: OpenClosing }> {
      for (const [key, value] of open) if (now() - value.at > CLOSING_OPEN_MS) open.delete(key);
      const quote = quotedClosingDay(userMessage, today);
      if (quote !== undefined) {
        const items = capItems(itemsOf ? await itemsOf(quote).catch(() => undefined) : undefined);
        const tentative = !isEveningNotice(quote) && quote.to >= today;
        return { line: closingDayNote(quote, items), closing: { quote, ...(items !== undefined ? { items } : {}), ...(tentative ? { tentative: true as const } : {}) } };
      }
      // A reply that quotes something else is about that, not the day: the closing ends there.
      if (leadingObject(userMessage)?.reply_to !== undefined) { open.delete(session_id); return { line: '' }; }
      const asked = open.get(session_id);
      if (asked === undefined) return { line: '' };
      // Proposed, then approved or refused: the day is settled, and the conversation moves on.
      if (asked.proposed === true && !(await (recordWaits?.(session_id, asked.quote) ?? Promise.resolve(false)).catch(() => false))) {
        open.delete(session_id); return { line: '' };
      }
      return { line: closingFollowUpNote(asked.quote, asked.items, asked.proposed === true),
        closing: { ...asked, follow_ups: (asked.follow_ups ?? 0) + 1 } };
    },
    /** After the turn: a record proposed closes it; otherwise the next turn carries it on. */
    end(session_id: string, closing: OpenClosing | undefined, toolNames: readonly string[]): void {
      if (closing === undefined) return;
      const proposed = closing.proposed === true || toolNames.includes('episode.record');
      // D-343 (the owner's app day, 2026-11-15) — "I'll do the Spanish lesson at lunch, move the plumber
      // call to 5 pm" quoted the morning's "Your day": the turns after it were told to ask about each
      // item left out, and the chat asked at 9:00 whether the plumber call had happened.
      if (closing.tentative === true && !proposed) { open.delete(session_id); return; }
      // Its record proposed, it stays open while that waits (a change replaces it); the follow-ups
      // count from the record, so talking it over is not cut short.
      if (!proposed && (closing.follow_ups ?? 0) >= CLOSING_FOLLOW_UPS) { open.delete(session_id); return; }
      open.set(session_id, { quote: closing.quote, ...(closing.items !== undefined ? { items: closing.items } : {}),
        ...(proposed && toolNames.includes('episode.record') ? {} : closing.follow_ups !== undefined ? { follow_ups: closing.follow_ups } : {}),
        ...(proposed ? { proposed: true as const } : {}), at: now() });
    },
  };
};

/** The note for a turn's message, or nothing when it quotes no Agenda or evening notice. The day's
 *  items come from `itemsOf`; a read that fails leaves the model to read the day. */
export const closingDayLine = async (userMessage: string, today: string,
  itemsOf?: (quote: ClosingQuote) => Promise<readonly ClosingItem[] | undefined>): Promise<string> => {
  const quote = quotedClosingDay(userMessage, today);
  if (quote === undefined) return '';
  const items = itemsOf ? await itemsOf(quote).catch(() => undefined) : undefined;
  return closingDayNote(quote, capItems(items));
};
