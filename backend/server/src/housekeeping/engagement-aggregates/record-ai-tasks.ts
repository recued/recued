/** D-139 slice 4 — the two AI-surface record aggregates.
 *
 *  Both keep `default_trust_state: 'manual'`. Registering them does not turn
 *  them on; it gives the owner a way to turn them on — a Settings row with
 *  the Off/Manual/Auto control, a dispatchable Run-Now, and manual fires that
 *  count toward the promotion banner at `MANUAL_RUN_THRESHOLD`. Before this,
 *  none of those existed for these topics.
 *
 *  Spec: D-139 § A.9.2. */

import {
  ENGAGEMENT_SENTIMENT_TOKEN_ESTIMATE,
  ENGAGEMENT_SENTIMENT_WINDOW_MS,
  processOneSentimentTrend,
  resolveSentimentTrendLayer,
} from './engagement-sentiment-trend.js';
import {
  NEXT_BEST_ACTION_TOKEN_ESTIMATE,
  NEXT_BEST_ACTION_WINDOW_MS,
  processOneNextBestAction,
  resolveNextBestActionLayer,
} from './next-best-action.js';
import { buildRecordAiTask } from './_record-ai-task.js';

export const engagementSentimentTrendTask = buildRecordAiTask({
  topic: 'engagement_sentiment_trend',
  crm_alias: 'deal',
  description:
    'Tone trajectory across a deal\'s engagements. AI-surface — costs tokens; stays off until you promote it.',
  window_ms: ENGAGEMENT_SENTIMENT_WINDOW_MS,
  token_estimate_per_record: ENGAGEMENT_SENTIMENT_TOKEN_ESTIMATE,
  resolveLayer: resolveSentimentTrendLayer,
  produce: processOneSentimentTrend,
});

export const nextBestActionTask = buildRecordAiTask({
  topic: 'next_best_action',
  crm_alias: 'deal',
  description:
    'Recommended next move on a deal, derived from its engagement context. AI-surface — costs tokens; stays off until you promote it.',
  window_ms: NEXT_BEST_ACTION_WINDOW_MS,
  token_estimate_per_record: NEXT_BEST_ACTION_TOKEN_ESTIMATE,
  resolveLayer: resolveNextBestActionLayer,
  produce: processOneNextBestAction,
});

export const RECORD_AI_TASKS = [
  engagementSentimentTrendTask,
  nextBestActionTask,
] as const;
