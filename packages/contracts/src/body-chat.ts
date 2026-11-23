/** D-339 slice 13 (D-339 §5.6) — a Body's own conversation, and what the owner approved
 *  sending to it.
 *
 *  The owner sends a Body's numbers to Chat from its page: what for, what about the person, which
 *  readings and days, and to which model. That confirmation is the approval, so it is kept on the Body,
 *  under one setting the page lists apart from its facts: the conversation the Body's numbers go to,
 *  and each approval, newest first. Each records what kind of thing went and to which model, never the
 *  values themselves: those are in the message, in that conversation. */
import type { ChatModelSourceId } from './chat.js';

/** The Body's setting that holds its conversation and the approvals. */
export const ASSET_CHAT_CONVERSATION = 'chat_conversation';

/** What the owner asked for, which writes the message's last paragraph. */
export const BODY_CHAT_REQUESTS = ['explain', 'diet', 'workout', 'other'] as const;
export type BodyChatRequest = (typeof BODY_CHAT_REQUESTS)[number];

/** D-339 slice 14 — the body measures that go with a weight: each has probably changed once the weight
 *  has moved since it was measured. Muscle mass is typed from a scale (Apple Health has none). */
export const BODY_MEASURE_FIELDS = ['body_fat', 'lean_body_mass', 'muscle_mass', 'waist'] as const;
export type BodyMeasureField = (typeof BODY_MEASURE_FIELDS)[number];

/** What about the person can go with the numbers. Age is sent, never the birth date; BMI (slice 14) is
 *  worked out from the height and weight; the body measures go with the day each was taken. */
export const BODY_CHAT_ABOUT = ['age', 'height', 'weight', 'bmi', 'gender', ...BODY_MEASURE_FIELDS,
  /** Slice 15 — the Body's goals. Slice 16 — its own ranges. */
  'goals', 'ranges'] as const;
export type BodyChatAbout = (typeof BODY_CHAT_ABOUT)[number];

/** The approvals kept on a Body, newest first. */
export const BODY_CHAT_SENT_KEPT = 20;

export interface BodyChatSent {
  at: number;
  request: BodyChatRequest;
  days: number;
  /** The readings in the message's table, by field. */
  readings: string[];
  about: BodyChatAbout[];
  /** The model it went to, and that model's name then ("Fast · qwen"). */
  source: ChatModelSourceId;
  source_label: string;
}

export interface AssetChatConversation {
  session_id: string;
  sent: BodyChatSent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** A Body's setting, read defensively: an older or hand-edited value reads as none, and an approval
 *  that does not parse is left out. */
export const readAssetChatConversation = (value: unknown): AssetChatConversation | undefined => {
  if (!isRecord(value) || typeof value.session_id !== 'string' || value.session_id === '') return undefined;
  const sent = Array.isArray(value.sent) ? value.sent.flatMap((row): BodyChatSent[] => {
    if (!isRecord(row) || typeof row.at !== 'number' || !Number.isFinite(row.at)) return [];
    if (!BODY_CHAT_REQUESTS.includes(row.request as BodyChatRequest)) return [];
    if (row.source !== 'slot_1' && row.source !== 'slot_2' && row.source !== 'free_pool') return [];
    return [{ at: row.at, request: row.request as BodyChatRequest, days: typeof row.days === 'number' ? row.days : 0,
      readings: strings(row.readings), about: strings(row.about).filter((item): item is BodyChatAbout => BODY_CHAT_ABOUT.includes(item as BodyChatAbout)),
      source: row.source, source_label: typeof row.source_label === 'string' ? row.source_label : row.source }];
  }) : [];
  return { session_id: value.session_id, sent: sent.slice(0, BODY_CHAT_SENT_KEPT) };
};
