/** Vendor message-length fitting — trim to fit, and SAY SO.
 *
 *  Every messenger caps a message and rejects an over-long send outright.
 *  That rejection goes nowhere useful: the D-158 notification block's
 *  fan-out treats delivery as best-effort and CATCHES a channel's throw, so
 *  an over-long message surfaces as no error at all — the channel silently
 *  delivers NOTHING while the others succeed. For an approval ask that is
 *  the worst outcome on offer: the owner never learns a decision is waiting,
 *  and the run sits paused on an answer nobody was asked for.
 *
 *  So a trimmed message is strictly better than no message — provided the
 *  trim is DISCLOSED. A silently shortened approval is the failure this
 *  whole surface exists to prevent (`batched-approval.ts` header: clipping
 *  must never hide what it cut); the marker is what keeps "lesser info"
 *  from becoming "wrong info".
 *
 *  The vendor's NUMBER stays with the vendor — each transport knows its own
 *  cap and declares it. Only the trimming is shared.
 */

/** Longest tail kept. Sized to hold an ask's closing question plus a link,
 *  not to preserve content — the tail is a landmark, not the payload. */
const TAIL_KEEP_MAX = 240;

/** Share of the budget the tail may claim when the text is short enough
 *  that {@link TAIL_KEEP_MAX} would eat most of it. */
const TAIL_SHARE = 0.15;

const markerFor = (dropped: number, vendor: string): string =>
  `\n\n[… ${dropped} characters trimmed to fit ${vendor} — open Recued for the full request …]\n\n`;

/** Trim `text` to `budget` characters, KEEPING BOTH ENDS and naming what
 *  went. Returns `text` unchanged when it already fits.
 *
 *  Middle-out rather than a tail cut, because of what sits at each end of an
 *  approval ask: the head says what wants to run, on which account, and why
 *  it stopped; the tail carries the question the buttons answer. A tail cut
 *  would leave the owner an [Approve] button under a sentence that no longer
 *  asks anything. What goes is the middle — the per-item detail — which is
 *  also exactly what the marker has to admit is missing.
 *
 *  Guarantees `result.length <= budget`: the marker is reserved at its
 *  widest (`dropped` can never have more digits than the whole text's
 *  length), so the marker that actually renders can only be shorter. */
export const fitText = (text: string, budget: number, vendor: string): string => {
  if (text.length <= budget) return text;
  const reserve = markerFor(text.length, vendor).length;
  const available = budget - reserve;
  // A budget too small to hold the marker itself can't disclose anything —
  // no vendor is remotely this tight, but a hard cut is the only total
  // answer, and returning over-budget text would defeat the whole point.
  if (available <= 0) return text.slice(0, Math.max(0, budget));
  const tailKeep = Math.min(TAIL_KEEP_MAX, Math.floor(available * TAIL_SHARE));
  const headKeep = available - tailKeep;
  const dropped = text.length - headKeep - tailKeep;
  return (
    text.slice(0, headKeep)
    + markerFor(dropped, vendor)
    + text.slice(text.length - tailKeep)
  );
};
