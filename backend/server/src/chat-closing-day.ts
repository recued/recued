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
export interface ClosingItem { readonly title: string; readonly ref: { readonly collection: string; readonly id: string; readonly field?: string } }
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
  const steps = [
    ...(listed ? [] : [`Read ${one ? 'the day' : 'each day'} with situation.query (time ${one ? quote.from : 'that day'}) for each item's ref.`]),
    `Record it in one episode.record call ${one ? `with day ${quote.from}` : 'per day (ask which day if they do not say)'}, before any other change: `
      + `each item they mention, done or skipped, in their words, with its ref${listed ? ' above' : ''}; anything else they did, with no item.`,
    // ⛔ After the record: one change is asked at a time (D-337), and a change not asked yet is
    // made again only once the conversation carries on. Measured with the tick-off first, that
    // turn ticked the task off and never made the record: the day was lost, and the owner had
    // been told it would be recorded.
    'Tick off with work.update a task they did, after the record (one change is asked at a time).',
    // D-340 slice 3 — a stream's reminders are not the day's items: each has its own answers. Without
    // this, 3 of 3 live closes asked whether to record a reminder due next month as skipped.
    `Ask about each item ${listed ? 'above' : 'on the notice'} they did not mention${quote.reminders ? ' (not the notice\'s Reminders, which they answer separately)' : ''}: `
      + 'leave it out, or record it as skipped?',
    'Say what you recorded.',
  ];
  return `\n[This replies to their notice “${quote.title}”, about ${days}.`
    + (listed ? ` Its items, each with its ref:\n${items.map((item) => `- ${item.title} ${JSON.stringify({ collection: item.ref.collection, id: item.ref.id,
      ...(item.ref.field !== undefined ? { field: item.ref.field } : {}) })}`).join('\n')}\n` : ' ')
    + `If the message tells you how ${one ? 'that day' : 'those days'} went, close ${one ? 'it' : 'each'}:\n`
    + `${steps.map((step, n) => `${n + 1}. ${step}`).join('\n')}]`;
};

/** The note for a turn's message, or nothing when it quotes no Agenda or evening notice. The day's
 *  items come from `itemsOf`; a read that fails leaves the model to read the day. */
export const closingDayLine = async (userMessage: string, today: string,
  itemsOf?: (quote: ClosingQuote) => Promise<readonly ClosingItem[] | undefined>): Promise<string> => {
  const quote = quotedClosingDay(userMessage, today);
  if (quote === undefined) return '';
  const items = itemsOf ? await itemsOf(quote).catch(() => undefined) : undefined;
  return closingDayNote(quote, items?.slice(0, CLOSING_ITEMS_MAX));
};
