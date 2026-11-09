/** D-346 follow-up (2026-11-08) — the fixes the owner's chat offers under an answer, for what a
 *  call in the turn could not do: a recipe run's need (a connection to reconnect or set up, a
 *  program to install, a program switched off for the owner) or one of the owner's own switches
 *  that refused a call ("'mail.search' is turned off for you"). The owner's ruling: show the run
 *  dialog's fixes under the model's answer, the way install offers already are.
 *
 *  Only on the owner's own chat (a contract's caller is told nothing about switches, the ruling
 *  of the same day), stamped by the server from the turn's tool results
 *  (`ChatDispatchResult.fixes` → `ChatMessage.fixes`), never from the model's text, and never
 *  read by a model: the model reads a result's `result`, not its side fields. */
import { COLLECTION_GRANT_PREFIX, PRIMITIVE_GRANT_PREFIX, RECIPE_GRANT_PREFIX, TOPIC_GRANT_PREFIX } from './grant-entry.js';
import type { RunNeed } from './run-needs.js';

/** One fix. `run_need`: what a failed run needed (`ServerExecuteResponse.run_needs`).
 *  `switch`: one of the owner's own switches on the Contracts page (`entry_key`), which the
 *  chat turns on (`contract.grant.write` on the owner's contract). */
export type ChatFix =
  | { readonly kind: 'run_need'; readonly need: RunNeed }
  | {
      readonly kind: 'switch';
      /** The grant entry the call needed (`primitive.mail.search`, `data.task`, …). */
      readonly entry_key: string;
      /** What to call it: the switch's title on the page, else the tool as it was called. */
      readonly label: string;
    };

/** At most this many under one answer: a turn that hit more needs a page, not a list. */
export const CHAT_FIX_LIMIT = 4;

/** The prefixes a `switch` fix may name: the owner's own switches the chat may turn on. A
 *  pack's own action (`<publisher>/<catalog>.<op>`) is turned on from its pack's page instead. */
const SWITCH_PREFIXES = [PRIMITIVE_GRANT_PREFIX, RECIPE_GRANT_PREFIX, COLLECTION_GRANT_PREFIX, TOPIC_GRANT_PREFIX, 'core.'];

const isRunNeed = (value: unknown): value is RunNeed => {
  if (value === null || typeof value !== 'object') return false;
  const need = value as { kind?: unknown; step_id?: unknown };
  return (need.kind === 'connection' || need.kind === 'program' || need.kind === 'switch')
    && typeof need.step_id === 'string';
};

/** The fixes in `value` that are well formed, deduplicated, at most `CHAT_FIX_LIMIT`: what a
 *  surface reads back from a stored message or a tool result. */
export const chatFixesOf = (value: unknown): ChatFix[] => {
  if (!Array.isArray(value)) return [];
  const out: ChatFix[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const fix = raw as { kind?: unknown; need?: unknown; entry_key?: unknown; label?: unknown };
    let key: string;
    let checked: ChatFix;
    if (fix.kind === 'run_need' && isRunNeed(fix.need)) {
      const need = fix.need;
      key = need.kind === 'switch'
        ? `switch:${need.ingredient_id}:${need.operation_id}`
        : need.kind === 'program'
          ? `program:${need.pack_slug ?? need.tool ?? need.step_id}:${need.problem}`
          : `connection:${need.slot}:${need.connection_name ?? ''}:${need.problem}`;
      checked = { kind: 'run_need', need };
    } else if (fix.kind === 'switch' && typeof fix.entry_key === 'string' && typeof fix.label === 'string'
      && SWITCH_PREFIXES.some((prefix) => (fix.entry_key as string).startsWith(prefix))) {
      key = `grant:${fix.entry_key}`;
      checked = { kind: 'switch', entry_key: fix.entry_key, label: fix.label };
    } else {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checked);
    if (out.length >= CHAT_FIX_LIMIT) break;
  }
  return out;
};
