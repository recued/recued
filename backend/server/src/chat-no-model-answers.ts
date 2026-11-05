/** D-338 — answers Recued gives without calling a model.
 *
 *  The deterministic gate (D-164 § 3, `chat-prompt-cache-gate.ts`) answers five kinds of question
 *  from the warehouse with zero model calls, and its answer is stored as an ordinary assistant
 *  row, so the next turn's window carries it like any reply. Two things still set it apart, and
 *  the owner ruled on both (2026-11-03):
 *
 *  - WHO answered. The app labels such a reply "without AI", with the store it read
 *    (`ChatMessage.answered_without_model`).
 *  - THE BRIEF. The rolling brief updates only after a turn that used tools, and this one used
 *    none, so a model-written answer's findings outlived the three-message window while this
 *    answer did not. The server adds it to the brief's findings itself, with no model call.
 *
 *  Spec: D-338. */
import type { ChatAnswerSource } from '@recued/contracts';
import type { TurnContext } from '@recued/middleware';
import { GATE_SHORT_CIRCUIT_STATE_KEY } from '@recued/middleware-prompt-cache';
import { hasAnchor, mergeBriefs, parseBrief, type RollingBrief } from './chat-rolling-brief.js';
import type { ChatStore } from './storage/chat-store.js';

const SOURCES: ReadonlySet<string> = new Set<ChatAnswerSource>(['contacts', 'calendar', 'mail']);

/** The marker for a turn the gate answered, or undefined when a model (or nothing) did. A family
 *  the host did not name reads as a reply without a source. */
export const gateAnswerOf = (state: TurnContext['state']): { from?: ChatAnswerSource } | undefined => {
  const raw = state.get(GATE_SHORT_CIRCUIT_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const source = (raw as { source?: unknown }).source;
  return typeof source === 'string' && SOURCES.has(source) ? { from: source as ChatAnswerSource } : {};
};

/** How much of one answer a finding keeps. A list answer names up to five people. */
const FINDING_MAX_CHARS = 1_000;

/** Add an answer given without a model to the conversation's brief, as a finding.
 *
 *  ⛔ `pending` IS CARRIED, NOT EMITTED. `mergeBriefs` takes the newer brief's `pending` as the
 *  current list, so a host brief with `pending: []` would erase the owner's "still to do". This
 *  brief repeats the stored list instead. `intent` stays the stored one (newest non-empty wins);
 *  with no brief yet, the owner's question is the anchor, as a brief cannot be stored without one.
 *
 *  Off when the owner turned the brief off. A failure costs only the finding. */
export const recordAnswerInBrief = async (
  store: Pick<ChatStore, 'getRollingBriefEnabled' | 'readSessionBrief' | 'writeSessionBrief'>,
  session_id: string,
  answer: string,
  question: string,
): Promise<void> => {
  if (!store.getRollingBriefEnabled()) return;
  const chars = Array.from(answer.trim());
  if (chars.length === 0) return;
  const finding = chars.length > FINDING_MAX_CHARS ? `${chars.slice(0, FINDING_MAX_CHARS).join('')}…` : chars.join('');
  const stored = await store.readSessionBrief(session_id);
  let previous: RollingBrief | null = null;
  if (stored !== null) {
    try { previous = parseBrief(JSON.parse(stored)); } catch { previous = null; }
  }
  const produced: RollingBrief = {
    intent: previous === null ? question.trim() : '',
    constraints: [],
    pending: previous?.pending ?? [],
    findings: [finding],
    completed: [],
  };
  const merged = mergeBriefs(previous, produced);
  if (!hasAnchor(merged)) return;
  await store.writeSessionBrief(session_id, JSON.stringify(merged));
};
