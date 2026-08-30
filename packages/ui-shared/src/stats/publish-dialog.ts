/** D-250 § D7 — the publish dialog: the whole payload, before any of it leaves.
 *
 *  🔑🔑 THIS IS § D2's VERIFIABILITY PROPERTY MADE LITERAL, and the spec words it as the
 *  acceptance test: *"here are your daily tokens, here are your daily ops, here is the
 *  ratio, and the ratio is the only thing that leaves."* A dialog that showed only the
 *  score would ask the owner to trust the arithmetic; showing the numerator and
 *  denominator beside it lets them check it.
 *
 *  ⛔⛔ AND IT SHOWS THE EXACT BYTES. Not a description of the payload — the payload. A
 *  summary can drift from what the submitter actually sends, and the moment it does, the
 *  dialog is worse than nothing: it is a confident, wrong promise about what left.
 *
 *  ⚠ THE COUNTS ARE LOCAL-ONLY (§ D2) AND THE DIALOG SAYS SO. A count publishes VOLUME —
 *  how much server you own — where a ratio publishes SKILL. They are shown here precisely
 *  BECAUSE they are not leaving; the contrast is the point.
 */

import type { MetricReadEntry, MetricSubmitSkipReason } from '@recued/contracts';

import { e } from '../template.js';

export interface PublishDialogProps {
  readonly metric: MetricReadEntry;
  readonly tag: string;
  readonly season_id: string;
  /** § D6 — the minimum activity to be ranked. Undefined means none is set. */
  readonly activity_floor?: number;
  /** Where it goes. Passed in rather than built here so the dialog cannot disagree with
   *  the destination the submitter actually uses. */
  readonly destination: string;
}

/** § B3.6 — a canonical decimal STRING with four places. ⛔ NOT a JSON number: JSON has
 *  no decimal type, so a number literal is an IEEE double and the exactness promise dies
 *  in transit. The dialog shows the same string the wire carries. */
export const toWireDecimal = (value: number): string => value.toFixed(4);

/** The literal submission entry. ⛔ BUILT BY THE SAME FUNCTION THE DIALOG RENDERS, so
 *  "what it says will leave" and "what leaves" cannot drift — the failure a hand-written
 *  summary invites. */
export const buildPublishPayload = (
  props: PublishDialogProps,
): { readonly value: string; readonly definition_version: number } | null => {
  const r = props.metric.reading;
  // ⛔ ABSENT AND UNBOUNDED ARE NOT SUBMITTABLE. There is no decimal for "nothing was
  // measured", and none for "better than every finite value" either — inventing 0 for the
  // first would publish a lie, and inventing a large number for the second would publish
  // a different one.
  if (r.kind !== 'value') return null;
  return { value: toWireDecimal(r.value), definition_version: props.metric.metric_version };
};

export const renderPublishDialog = (props: PublishDialogProps): string => {
  const { metric } = props;
  const payload = buildPublishPayload(props);

  if (!metric.publishable) {
    // ⛔ REFUSED, NOT HIDDEN. The rpc refuses this too (§ D2) — the dialog explains WHY,
    // so a missing option does not read as a bug.
    return `
      <section class="publish-dialog publish-dialog--refused" data-recued-publish-refused>
        <h3>${e(metric.label)} cannot be published</h3>
        <p>It is a raw count. Counts say how much server you run; boards compare how well
        you run it, so only ratios are publishable.</p>
      </section>`;
  }

  if (payload === null) {
    return `
      <section class="publish-dialog publish-dialog--nothing" data-recued-publish-nothing>
        <h3>Nothing to publish yet</h3>
        <p>${e(metric.label)} has no measured value for this window, so there is no number
        to send. It will be publishable once a cycle measures one.</p>
      </section>`;
  }

  const floorMet =
    props.activity_floor === undefined
    || (metric.denominator ?? 0) >= props.activity_floor;

  const counts = metric.numerator === undefined || metric.denominator === undefined
    ? '<p class="publish-note">The underlying figures are not recorded for this metric.</p>'
    : `
      <table class="publish-figures">
        <tbody>
          <tr><th>Numerator</th><td>${e(String(metric.numerator))}</td></tr>
          <tr><th>Denominator</th><td>${e(String(metric.denominator))}</td></tr>
          <tr><th>Ratio</th><td>${e(payload.value)}</td></tr>
        </tbody>
      </table>
      <p class="publish-note" data-recued-publish-localonly>
        The two figures above <strong>stay on this server</strong>. Only the ratio leaves.
      </p>`;

  return `
    <section class="publish-dialog" data-recued-publish-dialog>
      <h3>Publish ${e(metric.label)} to #${e(props.tag)}</h3>

      ${counts}

      <table class="publish-meta">
        <tbody>
          <tr><th>Definition version</th><td>v${payload.definition_version}</td></tr>
          <tr><th>Season</th><td>${e(props.season_id)}</td></tr>
          <tr><th>Destination</th><td>${e(props.destination)}</td></tr>
          <tr><th>Activity floor</th><td>${
            props.activity_floor === undefined
              ? 'none'
              : `${e(String(props.activity_floor))}${floorMet ? '' : ' — not met yet'}`
          }</td></tr>
        </tbody>
      </table>

      <h4>Exactly what will be sent</h4>
      <pre class="publish-payload" data-recued-publish-payload>${
        e(JSON.stringify({ [props.tag]: payload }, null, 2))
      }</pre>

      <p class="publish-note">Your server signs this and sends it once a day. You can stop
      at any time — see below.</p>
    </section>`;
};

/** § D7 — *"Stop publishing and erase my entry" is a PROMINENT action, not an
 *  account-management afterthought*: § C4 ruled the erase, and burying it makes the
 *  ruling decorative.
 *
 *  ⚠ IT DESCRIBES WHAT ACTUALLY HAPPENS, INCLUDING THE DELAY. § C4's withdrawal rides the
 *  daily batch until the cloud acks it, so "gone instantly" would be a promise the design
 *  does not make. And it erases ACROSS ALL SEASONS — "a partial exit that leaves last
 *  season's rank standing is not leaving". */
export const renderStopPublishing = (props: { tag: string; withdrawing: boolean }): string =>
  props.withdrawing
    ? `
      <section class="publish-stop publish-stop--pending" data-recued-publish-withdrawing>
        <h4>Leaving #${e(props.tag)}</h4>
        <p>Your entry is being removed. Your server carries the withdrawal on every
        submission until the board confirms it is gone — usually within a day.</p>
      </section>`
    : `
      <section class="publish-stop" data-recued-publish-stop>
        <h4>Stop publishing to #${e(props.tag)}</h4>
        <p>Removes your entry from every season of this board, not just the current one.</p>
        <button type="button" data-recued-publish-stop-action data-tag="${e(props.tag)}">
          Stop publishing and erase my entry
        </button>
      </section>`;

/** § D4 / § D7 — the ENTRY POINT. ⛔⛔ WITHOUT THIS THE DIALOG IS UNREACHABLE: publications
 *  are the only thing that makes {@link renderPublishDialog} render, and nothing else can
 *  create one. Omitting it was a deliberate call — "choosing a tag is a distinct act, so no
 *  button should guess one" — and the reasoning was right about GUESSING while the
 *  conclusion was wrong: the answer is to ASK for the tag, not to leave no way in.
 *
 *  🔑 TWO STEPS, AND § D7 REQUIRES THE ORDER. *"The publish dialog carries the whole
 *  payload … before any of it leaves."* So: name the tag, SEE the exact bytes, then confirm.
 *  A one-click publish would send a number the owner never saw. */
export const renderPublishStart = (props: {
  readonly metric: MetricReadEntry;
  readonly pending?: { readonly tag: string; readonly season_id: string };
}): string => {
  const { metric } = props;
  // ⛔ A non-publishable metric offers no entry at all — § D2 refuses it at the rpc, and a
  // control that always fails is worse than an absent one.
  if (!metric.publishable) return '';
  if (metric.reading.kind !== 'value') {
    return `<p class="publish-note" data-recued-publish-unmeasured="${e(metric.metric_id)}">
      ${e(metric.label)} has no measured value yet, so there is nothing to publish.</p>`;
  }
  if (props.pending !== undefined) {
    return `
      <div class="publish-confirm" data-recued-publish-confirm="${e(metric.metric_id)}">
        ${renderPublishDialog({
          metric,
          tag: props.pending.tag,
          season_id: props.pending.season_id,
          destination: `https://recued.com/explore/${props.pending.tag}`,
        })}
        <button type="button" data-recued-publish-confirm-action
          data-metric="${e(metric.metric_id)}" data-tag="${e(props.pending.tag)}"
          data-season="${e(props.pending.season_id)}">Publish this number</button>
        <button type="button" data-recued-publish-cancel-action>Cancel</button>
      </div>`;
  }
  return `
    <form class="publish-start" data-recued-publish-start="${e(metric.metric_id)}">
      <label>Publish ${e(metric.label)} to
        <input type="text" data-recued-publish-tag placeholder="tag" required>
      </label>
      <label>season
        <input type="text" data-recued-publish-season value="1" required>
      </label>
      <button type="button" data-recued-publish-preview-action
        data-metric="${e(metric.metric_id)}">Preview what would be sent</button>
    </form>`;
};

/** § B3.3 — send the batch now. ⚠ Rendered only when something IS published: a send with an
 *  empty batch posts nothing, so a button offering it would do visibly nothing. */
/** What the last send did, as the owner needs to read it.
 *
 *  ⛔⛔ THE OUTCOME USED TO BE DISCARDED ENTIRELY — the route did
 *  `void submit().then(refresh, refresh)` and the screen was identical before and after.
 *  With no board existing anywhere yet, that button was guaranteed to do nothing visible,
 *  forever, with no explanation. A live drive is what made that obvious; nothing else
 *  could have, because "worked" and "silently did nothing" render the same.
 *
 *  🔑 EVERY LINE NAMES WHAT IS TRUE OF THE SERVER, NOT WHAT FAILED. Four of the five
 *  outcomes are a correctly-working server that has not opted into something (§ D4), so
 *  phrasing them as errors would be a lie in the owner's own dashboard. */
const SUBMIT_OUTCOME_TEXT: Readonly<Record<MetricSubmitSkipReason, string>> = {
  no_identity: 'This server has no signing identity yet, so it cannot publish. '
    + 'Nothing was sent and nothing was lost.',
  no_handle: 'This server needs a publisher handle before it can publish — it is free '
    + 'with any account. Nothing was sent.',
  no_publications: 'You are not publishing anything, so there was nothing to send.',
  nothing_measured: 'Nothing measured for the boards you are on this window, so nothing '
    + 'was sent. Your entry keeps the number it already had.',
  // ⛔ DO NOT SAY "the next send will retry". There is no next send — this button is the
  // only caller of the submit path, which is exactly the false promise removed from the
  // note above. Telling the owner to press it again is both true and actionable.
  send_failed: 'Could not reach the board. Nothing changed — press send again in a moment.',
};

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** ⛔⛔ A REJECTION IS AN ANSWER, AND COUNTING IT AS ONE READ AS SUCCESS. This said
 *  "Sent. N boards answered." off `results.length`, so a batch whose every entry came
 *  back `{kind:'rejected', reason:'unknown_board'}` rendered as an unqualified success.
 *  Harmless only while no board exists to be rejected against — and once boards exist,
 *  `unknown_board` becomes the ORDINARY way a local fork or a retired season fails, so
 *  the reassuring version would have been the common case.
 *
 *  🔑 THREE KINDS, THREE MEANINGS. `ranked` is a score that landed; `withdrawn` is § C4's
 *  ack, the only thing that terminates a withdrawal's retry and worth saying out loud;
 *  `rejected` is an entry the board refused. Summing them answers no question anyone has. */
const submitSentText = (o: {
  readonly ranked: number; readonly withdrawn: number;
  readonly rejected: number; readonly rejectedReasons: readonly string[];
}): string => {
  const parts: string[] = [];
  if (o.ranked > 0) parts.push(`${plural(o.ranked, 'board', 'boards')} updated`);
  if (o.withdrawn > 0) parts.push(`${plural(o.withdrawn, 'withdrawal', 'withdrawals')} confirmed`);
  const why = o.rejectedReasons.length > 0 ? ` (${o.rejectedReasons.join(', ')})` : '';
  // ⛔ ALL-REJECTED IS NOT A SEND THAT WORKED. The request succeeded and NOTHING the owner
  // published was accepted; leading with "Sent." would bury that behind good news.
  if (o.ranked === 0 && o.withdrawn === 0) {
    return o.rejected > 0
      ? `Nothing was accepted — ${plural(o.rejected, 'entry', 'entries')} rejected${why}.`
      // A 200 carrying no results at all. Rare, and saying "sent" alone would imply a
      // landing this cannot confirm.
      : 'Sent, but the board reported nothing back.';
  }
  const rejected = o.rejected > 0
    ? `, ${plural(o.rejected, 'entry', 'entries')} rejected${why}`
    : '';
  return `Sent. ${parts.join(', ')}${rejected}.`;
};

export const renderSubmitNow = (props: {
  readonly publications: number;
  /** Absent until the owner has actually pressed the button this session. */
  readonly outcome?:
    | {
        readonly sent: true;
        readonly ranked: number;
        readonly withdrawn: number;
        readonly rejected: number;
        /** Distinct reasons, so a batch of ten `unknown_board`s says it once. */
        readonly rejectedReasons: readonly string[];
      }
    | { readonly sent: false; readonly reason: MetricSubmitSkipReason };
}): string => {
  if (props.publications === 0) return '';
  const { outcome } = props;
  // ⛔ A SEND WHERE NOTHING LANDED GETS ITS OWN STATUS VALUE, not `sent`. The attribute is
  // what styling and tests key on, so folding it into `sent` would hide the case in both.
  const state = outcome === undefined
    ? ''
    : !outcome.sent
      ? outcome.reason
      : outcome.ranked === 0 && outcome.withdrawn === 0 && outcome.rejected > 0
        ? 'rejected'
        : 'sent';
  const status = outcome === undefined
    ? ''
    : `<p class="publish-submit-status" data-recued-submit-status="${e(state)}">${
        outcome.sent
          ? e(submitSentText(outcome))
          : e(SUBMIT_OUTCOME_TEXT[outcome.reason])
      }</p>`;
  return `<div class="publish-submit">
        <button type="button" data-recued-submit-action>Send today’s scores now</button>
        ${status}
      </div>`;
};
