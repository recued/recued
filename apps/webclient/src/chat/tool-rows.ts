/** How a loaded conversation shows its `role: 'tool'` rows — pure projections.
 *
 *  ⛔ A TOOL ROW'S BODY IS A RECALL FORMAT, NOT A DISPLAY. The server writes
 *  `<name>(<args>)` and `<name>: <result>` (`backend/server/src/chat-tool-row.ts`)
 *  so lexical recall can find both the act and its data. Drawn as-is, every call
 *  in a reloaded conversation read as raw JSON — while the LIVE view showed the
 *  same calls as one activity line each ("used … ✓"), because it holds no tool
 *  rows at all. Same conversation, two different pictures depending on whether
 *  the page had been reloaded.
 *
 *  So a loaded conversation now matches the live one:
 *  - a call, or its result, whose answer lists it is FOLDED into that answer's
 *    activity rows — it is already there, once;
 *  - a late result (`settle:<run_id>`: a call that finished after its turn,
 *    usually once approved) shows under its answer as "What … returned",
 *    readable first and raw behind a disclosure — D-259 Slice 4 keeps it
 *    owner-visible in Chat, and it still is;
 *  - a row no answer lists (an interrupted turn, or an answer outside the loaded
 *    window) stays a row of its own: a sentence, with the raw text behind a
 *    disclosure. Nothing is dropped.
 *
 *  ⚠ The parse is lenient on purpose: a body the server capped, or a format this
 *  client does not know, falls back to the raw text — never to an error. */

import type { ChatMessage } from '@recued/contracts';

export interface LateToolResult {
  readonly message_id: string;
  readonly run_id: string;
  /** As the answer's own activity row names it, when the answer lists the run. */
  readonly tool_name: string;
  readonly text: string;
}

export interface ToolRowPlan {
  /** Tool rows not drawn as messages of their own. */
  readonly folded: ReadonlySet<string>;
  /** Late results by the id of the answer they belong to, in history order. */
  readonly late_results: ReadonlyMap<string, readonly LateToolResult[]>;
  /** A call row's own result text, for a call drawn on its own. */
  readonly result_text_by_call: ReadonlyMap<string, string>;
}

const SETTLE_PREFIX = 'settle:';
const RESULT_SUFFIX = ':result';

/** The tool name a row body leads with: everything before the first `(` or
 *  `: ` — the client twin of the server's `toolNameFromRow`. */
export const toolNameOfRow = (content: string): string | undefined => {
  const cut = content.search(/\(|: /u);
  const name = (cut === -1 ? content : content.slice(0, cut)).trim();
  return name.length > 0 && !name.includes(' ') ? name : undefined;
};

export const planToolRows = (messages: readonly ChatMessage[]): ToolRowPlan => {
  const answerByTurn = new Map<string, ChatMessage>();
  const answerById = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    answerById.set(message.id, message);
    if (message.turn_id !== undefined && !answerByTurn.has(message.turn_id)) {
      answerByTurn.set(message.turn_id, message);
    }
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  /** The answer that LISTS this call — never just the turn's answer: a call its
   *  answer does not list would vanish if folded into it. */
  const listingAnswer = (row: ChatMessage): ChatMessage | undefined => {
    const legacyOwner = row.id.includes(':tool:') ? answerById.get(row.id.split(':tool:')[0]!) : undefined;
    const answer = legacyOwner ?? (row.turn_id !== undefined ? answerByTurn.get(row.turn_id) : undefined);
    if (answer === undefined) return undefined;
    const name = row.tool_call?.tool_name ?? toolNameOfRow(row.content);
    const run_id = row.tool_call?.run_id;
    const listed = (answer.tool_calls ?? []).some((call) =>
      (run_id !== undefined && call.run_id === run_id)
      || (call.tool_name === name && (run_id === undefined || call.run_id === undefined)));
    return listed ? answer : undefined;
  };

  const folded = new Set<string>();
  const late_results = new Map<string, LateToolResult[]>();
  const result_text_by_call = new Map<string, string>();
  for (const row of messages) {
    if (row.role !== 'tool') continue;
    if (row.id.startsWith(SETTLE_PREFIX)) {
      const run_id = row.id.slice(SETTLE_PREFIX.length);
      // By run first: the answer that dispatched this exact run. Else its turn.
      const byRun = [...answerById.values()].find((answer) =>
        (answer.tool_calls ?? []).some((call) => call.run_id === run_id));
      const answer = byRun ?? (row.turn_id !== undefined ? answerByTurn.get(row.turn_id) : undefined);
      if (answer === undefined) continue;
      const listedName = (answer.tool_calls ?? []).find((call) => call.run_id === run_id)?.tool_name;
      const list = late_results.get(answer.id) ?? [];
      list.push({ message_id: row.id, run_id,
        tool_name: listedName ?? toolNameOfRow(row.content) ?? 'the call', text: row.content });
      late_results.set(answer.id, list);
      folded.add(row.id);
      continue;
    }
    if (row.id.endsWith(RESULT_SUFFIX)) {
      const call = byId.get(row.id.slice(0, -RESULT_SUFFIX.length));
      if (call !== undefined) {
        // Folded with its call, or carried in the call's own details.
        result_text_by_call.set(call.id, row.content);
        folded.add(row.id);
        continue;
      }
    }
    if (listingAnswer(row) !== undefined) folded.add(row.id);
  }
  return { folded, late_results, result_text_by_call };
};

export interface ReadableToolResult {
  /** A recipe's own summary fields, as its result card shows them. */
  readonly summary: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** A plain message the result carries (a refusal, a cancellation). */
  readonly message?: string;
  /** The body, pretty-printed when it parses; as written when it does not. */
  readonly raw: string;
}

const summaryFieldsOf = (value: unknown): Array<{ label: string; value: string }> => {
  if (value === null || typeof value !== 'object') return [];
  const render = (value as { output?: { render?: unknown } }).output?.render;
  if (!Array.isArray(render)) return [];
  return render.flatMap((section: unknown) => {
    if (section === null || typeof section !== 'object'
      || (section as { type?: unknown }).type !== 'summary') return [];
    const fields = (section as { data?: { fields?: unknown } }).data?.fields;
    if (!Array.isArray(fields)) return [];
    return fields.flatMap((field: unknown) => {
      if (field === null || typeof field !== 'object') return [];
      const { label, value: fieldValue } = field as { label?: unknown; value?: unknown };
      if (typeof label !== 'string' || label.length === 0 || fieldValue === undefined || fieldValue === null) return [];
      return [{ label, value: typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue) }];
    });
  });
};

/** Read a result row body (`<name>: <result>`) for a person. */
export const readToolResult = (text: string): ReadableToolResult => {
  const cut = text.indexOf(': ');
  const body = cut === -1 ? text : text.slice(cut + 2);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { summary: [], raw: body }; }
  // A chat tool result wraps the run as `{ ok, result }`; a settled run is bare.
  const inner = parsed !== null && typeof parsed === 'object'
    && 'result' in parsed && !('output' in parsed)
    ? (parsed as { result?: unknown }).result : parsed;
  const message = [inner, parsed].map((value) =>
    value !== null && typeof value === 'object' ? (value as { message?: unknown }).message : undefined)
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    summary: summaryFieldsOf(inner),
    ...(message !== undefined ? { message } : {}),
    raw: JSON.stringify(parsed, null, 2),
  };
};

/** The one sentence a tool row drawn on its own leads with. */
export const describeToolRow = (row: ChatMessage): string => {
  const name = row.tool_call?.tool_name ?? toolNameOfRow(row.content) ?? 'a tool';
  if (row.id.startsWith(SETTLE_PREFIX)) return `A later result from ${name}`;
  if (row.id.endsWith(RESULT_SUFFIX)) return `The result from ${name}`;
  return `Called ${name}`;
};
