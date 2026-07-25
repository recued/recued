/** D-192 messenger flagship (M1b) — the Slack `users.info` profile-email leaf.
 *
 *  The per-vendor adapter leaf (kinds-taxonomy §0) behind the messenger
 *  declaration's `identity.platform_id_source: 'profile_email'`: given a Slack
 *  bot token + a sender's `U…` user id, resolve the sender's profile email so
 *  the messenger→contact link writer (`ensureMessengerSenderLinked`) can record
 *  a `(slack, U…) → email` link. Needs the `users:read.email` bot-token scope.
 *
 *  A standalone function, deliberately NOT part of the vendor-agnostic
 *  `Transport` interface — a profile lookup is Slack-specific identity, not the
 *  messaging send/receive the interface models (Telegram exposes no email at
 *  all). It lives here to co-locate with the other Slack API calls
 *  (`chat.postMessage` / `files.info`) and reuse the package's `postJson`
 *  timeout/never-throws HTTP helper.
 *
 *  FAIL-SOFT: returns `null` on EVERY failure mode — a network / timeout error,
 *  a non-2xx, an `ok: false` envelope (`missing_scope` when the token lacks
 *  `users:read.email`, `user_not_found`, a rate limit), or an absent / blank
 *  email. The caller treats `null` as "the sender stays unlinked" (the owner
 *  fills the counterparty at approval — the F1 nullable posture); it never
 *  throws.
 *
 *  Spec: D-192 § 3a (M-1). */

import { DEFAULT_TIMEOUT_MS, postJson } from './http.js';

const SLACK_USERS_INFO_URL = 'https://slack.com/api/users.info';

/** The subset of the `users.info` response we read. */
interface SlackUsersInfoEnvelope {
  ok?: boolean;
  error?: string;
  user?: { profile?: { email?: string | null } };
}

export interface FetchSlackUserEmailOptions {
  /** Inject for testing; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout; defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Resolve a Slack user's profile email via `users.info`. Fail-soft → `null`
 *  (see file header). The email is trimmed; casing is preserved (the caller
 *  canonicalizes for the contact store). */
export const fetchSlackUserEmail = async (
  token: string,
  userId: string,
  opts: FetchSlackUserEmailOptions = {},
): Promise<string | null> => {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (token.length === 0 || userId.length === 0) return null;

  // The `user` argument rides the QUERY STRING, not a JSON body: Slack reads
  // method arguments from the query string for ANY method, whereas
  // `application/json` bodies are only accepted by a per-method opt-in subset
  // (the write methods like `chat.postMessage`) — a read method like
  // `users.info` could silently ignore a JSON body and report the argument
  // missing. `postJson` gives the never-throws + timeout wrapper; the empty
  // body + Bearer header is a plain authenticated call.
  const url = `${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(userId)}`;
  const outcome = await postJson(url, {
    headers: { Authorization: `Bearer ${token}` },
    body: '',
    timeoutMs,
    fetchImpl,
  });
  // network / timeout / non-2xx — `postJson` never throws.
  if (!outcome.ok) return null;

  const env = (outcome.json ?? {}) as SlackUsersInfoEnvelope;
  // Slack signals method-level failure in the body with `ok: false` +
  // `error` (`missing_scope` / `user_not_found` / `ratelimited` / …), a 200.
  if (env.ok !== true) return null;

  const email = env.user?.profile?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email.trim() : null;
};
