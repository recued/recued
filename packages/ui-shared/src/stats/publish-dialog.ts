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

import type { MetricReadEntry } from '@recued/contracts';

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
