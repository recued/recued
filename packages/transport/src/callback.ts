/** D-158 P2 — the interactive-prompt callback codec.
 *
 *  An `OutboundPrompt` option's vendor callback payload — a Slack button
 *  `value`, a Telegram inline-keyboard `callback_data` — carries the
 *  prompt's `correlation_id` and the chosen option id, joined by a `|`.
 *  The inbound button press round-trips that string back verbatim;
 *  `decodeChoice` recovers the pair.
 *
 *  Split on the FIRST `|`: `correlation_id` is `|`-free by the
 *  `OutboundPrompt` contract, so everything after the first separator is
 *  the option id (which therefore MAY itself contain a `|`).
 *
 *  Spec: D-158 § P2 / A.4.
 */

/** The callback-payload field separator. */
const SEPARATOR = '|';

/** Encode `(correlation_id, option_id)` into one vendor callback
 *  string. The caller guarantees `correlation_id` is `|`-free
 *  (`OutboundPrompt` contract). */
export const encodeChoice = (
  correlation_id: string,
  option_id: string,
): string => `${correlation_id}${SEPARATOR}${option_id}`;

/** Decode a vendor callback string back into its pair, or `null` when
 *  the string is not a well-formed encoding — no separator, an empty
 *  `correlation_id`, or an empty option id. */
export const decodeChoice = (
  data: string,
): { correlation_id: string; option_id: string } | null => {
  const at = data.indexOf(SEPARATOR);
  // No separator (-1), or it is the first byte (empty correlation_id),
  // or the last byte (empty option id) — none is a valid encoding.
  if (at <= 0 || at >= data.length - 1) return null;
  return {
    correlation_id: data.slice(0, at),
    option_id: data.slice(at + 1),
  };
};
