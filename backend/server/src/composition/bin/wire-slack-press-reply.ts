/** D-325 §5.1 — a press on a Slack reminder that already closed says so.
 *
 *  Slack needs no acknowledgement after a button press, so this is not one: it
 *  posts only when there is something to say. A Slack `block_actions` payload
 *  carries a `response_url`, and a message posted there with
 *  `response_type: 'ephemeral'` is shown to the person who pressed and no one
 *  else, leaving the reminder message itself as it is.
 *
 *  The url is used only when its origin is Slack's hooks host, and fetched
 *  through the origin-pinned fetch, so a payload cannot point the server
 *  anywhere else. Best-effort like the Telegram ack: the dispatcher catches
 *  every throw, because a webhook 502 would make Slack deliver the press again. */

import { discardResponseBody, fetchOriginPinned } from '@recued/ingredients';

const SLACK_RESPONSE_ORIGIN = 'https://hooks.slack.com';

/** A press is answered within seconds or the presser has moved on; the same
 *  window as the Telegram ack. */
const SLACK_PRESS_REPLY_TIMEOUT_MS = 3_000;

export interface ComposeSlackPressReplyDeps {
  /** Test-only fetch override. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test-only timeout override. Defaults to `SLACK_PRESS_REPLY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** The Telegram ack's shape, so it sits in the dispatcher's per-vendor table. */
export type SlackPressReply = (
  payload: unknown,
  connection_name: string,
  text?: string,
) => Promise<void>;

const responseUrlOf = (payload: unknown): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const raw = (payload as { response_url?: unknown }).response_url;
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.origin === SLACK_RESPONSE_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
};

export const composeSlackPressReply = (
  deps: ComposeSlackPressReplyDeps = {},
): SlackPressReply => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? SLACK_PRESS_REPLY_TIMEOUT_MS;

  return async (payload, _connection_name, text) => {
    if (!text) return;
    const url = responseUrlOf(payload);
    if (url === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetchOriginPinned(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
          signal: controller.signal,
        },
        SLACK_RESPONSE_ORIGIN,
      );
    } finally {
      if (response !== undefined) discardResponseBody(response);
      clearTimeout(timer);
    }
  };
};
