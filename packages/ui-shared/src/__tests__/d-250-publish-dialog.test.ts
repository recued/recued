/** D-250 § D7 — the publish dialog.
 *
 *  🔑 THE ACCEPTANCE TEST IS § D2's OWN SENTENCE: "here are your daily tokens, here are
 *  your daily ops, here is the ratio, and the ratio is the only thing that leaves." Most
 *  cases below are that sentence, one clause at a time.
 */

import { describe, expect, it } from 'vitest';
import { METRIC_ABSENT, METRIC_UNBOUNDED, metricValue, type MetricReadEntry } from '@recued/contracts';

import {
  buildPublishPayload,
  renderPublishDialog,
  renderPublishStart,
  renderStopPublishing,
  renderSubmitNow,
  toWireDecimal,
} from '../stats/publish-dialog.js';

const metric = (over: Partial<MetricReadEntry> = {}): MetricReadEntry => ({
  metric_id: 'autopilot', metric_version: 2, reading: metricValue(0.625),
  label: 'Autopilot', shape: 'share', direction: 'higher', publishable: true,
  numerator: 25, denominator: 40, ...over,
});

const props = (over = {}) => ({
  metric: metric(), tag: 'ops', season_id: '1',
  destination: 'https://recued.com/explore/ops', ...over,
});

describe('D-250 § B3.6 — the wire value is a canonical decimal STRING', () => {
  it('⛔⛔ FOUR PLACES, AS A STRING — a JSON number is a double', () => {
    // The exactness promise dies in transit otherwise, before Postgres' numeric column
    // ever sees it.
    expect(toWireDecimal(0.625)).toBe('0.6250');
    expect(typeof buildPublishPayload(props())!.value).toBe('string');
  });

  it('the payload carries the version that computed it', () => {
    expect(buildPublishPayload(props())!.definition_version).toBe(2);
  });
});

describe('D-250 § D2 — the counts are shown BECAUSE they are not leaving', () => {
  it('⛔⛔ NUMERATOR, DENOMINATOR AND RATIO ARE ALL VISIBLE', () => {
    const html = renderPublishDialog(props());
    expect(html).toContain('>25<');
    expect(html).toContain('>40<');
    expect(html).toContain('0.6250');
  });

  it('⛔⛔ AND IT SAYS THE FIGURES STAY LOCAL — the contrast IS the feature', () => {
    // Without this line the dialog reads as "we are sending all of this", which is the
    // opposite of § D2's guarantee.
    const html = renderPublishDialog(props());
    expect(html).toContain('data-recued-publish-localonly');
    expect(html).toContain('stay on this server');
  });

  it('⛔⛔ THE PAYLOAD BLOCK CONTAINS THE RATIO AND NOT THE COUNTS', () => {
    // The single most load-bearing assertion here: if a count ever appears in the bytes,
    // § D2's scale-invariance guarantee is broken and the dialog is the last place it
    // could have been noticed.
    // ⚠ CHECKED STRUCTURALLY, NOT BY SUBSTRING. A naive `not.toContain('25')` fails on
    // the ratio "0.6250" itself — the assertion would have to be weakened to pass, which
    // is how a real check quietly becomes decorative. The property is about KEYS.
    const built = buildPublishPayload(props())!;
    expect(Object.keys(built).sort()).toEqual(['definition_version', 'value']);
    expect(JSON.stringify(built)).not.toContain('numerator');
    expect(JSON.stringify(built)).not.toContain('denominator');
    // ...and the rendered block is that object and nothing else.
    const html = renderPublishDialog(props());
    const start = html.indexOf('data-recued-publish-payload') + 'data-recued-publish-payload'.length + 1;
    const block = html.slice(start, html.indexOf('</pre>', start));
    expect(JSON.parse(block.replace(/&quot;/g, '"'))).toEqual({ ops: built });
  });

  it('degrades honestly when the figures were not recorded', () => {
    const html = renderPublishDialog(props({
      metric: metric({ numerator: undefined, denominator: undefined }),
    }));
    expect(html).toContain('not recorded');
  });
});

describe('D-250 § D7 — the dialog shows the exact bytes', () => {
  it('⛔ THE RENDERED PAYLOAD IS BUILT BY THE SAME FUNCTION, not described', () => {
    // A hand-written summary can drift from what the submitter sends, and the moment it
    // does the dialog is worse than nothing — a confident, wrong promise about what left.
    const p = props();
    const html = renderPublishDialog(p);
    expect(html).toContain(JSON.stringify({ ops: buildPublishPayload(p) }, null, 2)
      .replace(/"/g, '&quot;'));
  });

  it('carries version, season, destination and floor', () => {
    const html = renderPublishDialog(props({ activity_floor: 10 }));
    expect(html).toContain('v2');
    expect(html).toContain('https://recued.com/explore/ops');
    expect(html).toContain('10');
  });

  it('⛔ AN UNMET FLOOR IS SAID OUT LOUD, not silently dropped at submit', () => {
    // § D6: a ratio over a tiny denominator is noise. An owner who cannot be ranked
    // should learn it here, not from an entry that never appears.
    expect(renderPublishDialog(props({ activity_floor: 500 }))).toContain('not met yet');
    expect(renderPublishDialog(props({ activity_floor: 10 }))).not.toContain('not met yet');
  });
});

describe('D-250 — what cannot be published', () => {
  it('⛔⛔ A COUNT IS REFUSED WITH A REASON, not hidden', () => {
    // A missing option reads as a bug; § D2's reasoning is short enough to just say.
    const html = renderPublishDialog(props({ metric: metric({ publishable: false, shape: 'count' }) }));
    expect(html).toContain('data-recued-publish-refused');
    expect(html).toContain('cannot be published');
    expect(html).not.toContain('data-recued-publish-payload');
  });

  it('⛔⛔ ABSENT IS NOT SUBMITTABLE — there is no decimal for "nothing was measured"', () => {
    // Inventing 0 would publish a lie about a server that simply had no data.
    const p = props({ metric: metric({ reading: METRIC_ABSENT }) });
    expect(buildPublishPayload(p)).toBeNull();
    expect(renderPublishDialog(p)).toContain('data-recued-publish-nothing');
  });

  it('⛔⛔ UNBOUNDED IS NOT SUBMITTABLE EITHER', () => {
    // "Better than every finite value" has no decimal, and picking a large one publishes
    // a different lie than picking 0.
    expect(buildPublishPayload(props({ metric: metric({ reading: METRIC_UNBOUNDED }) }))).toBeNull();
  });
});

describe('D-250 § C4 / § D7 — stopping is prominent and honest', () => {
  it('offers the erase as an action, and says it spans ALL seasons', () => {
    // "A partial exit that leaves last season's rank standing is not leaving."
    const html = renderStopPublishing({ tag: 'ops', withdrawing: false });
    expect(html).toContain('data-recued-publish-stop-action');
    expect(html).toContain('every season');
  });

  it('⛔⛔ WHILE WITHDRAWING IT DESCRIBES THE DELAY rather than claiming "gone"', () => {
    // § C4's withdrawal rides the daily batch until the cloud acks it. "Removed
    // instantly" is a promise the design does not make, and the owner would check the
    // board and think it failed.
    const html = renderStopPublishing({ tag: 'ops', withdrawing: true });
    expect(html).toContain('data-recued-publish-withdrawing');
    expect(html).toContain('until the board confirms');
    expect(html).not.toContain('data-recued-publish-stop-action');
  });
});

describe('D-250 — escaping', () => {
  it('escapes the tag and the label', () => {
    const html = renderPublishDialog(props({
      tag: '"><script>x</script>', metric: metric({ label: '<img onerror=y>' }),
    }));
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('<img onerror');
  });
});


// ────────────────────────────────────────────────────────────────
// § D7 — the entry point INTO the dialog
// ────────────────────────────────────────────────────────────────

describe('D-250 § D7 — the publish entry point', () => {
  /** ⛔⛔ THE DIALOG WAS BUILT AND NOTHING OPENED IT. `renderPublications` returns ''
   *  with no publications, publishing was the only way to get one, and no surface asked
   *  for a tag — so every case in this file was exercising markup no owner could reach.
   *  These cases cover the door. */
  it('⛔ AN UNMEASURED METRIC OFFERS A REASON, NOT A CONTROL', () => {
    // Publishing `absent` would put a blank row on a public board, and § D2's reading
    // kinds exist precisely so "not measured" never renders as a number.
    const html = renderPublishStart({ metric: metric({ reading: METRIC_ABSENT }) });
    expect(html).not.toContain('data-recued-publish-preview-action');
    expect(html).toContain('data-recued-publish-unmeasured');
    expect(html).toContain('nothing to publish');
  });

  it('an UNBOUNDED reading is unpublishable for the same reason', () => {
    const html = renderPublishStart({ metric: metric({ reading: METRIC_UNBOUNDED }) });
    expect(html).not.toContain('data-recued-publish-preview-action');
    expect(html).toContain('data-recued-publish-unmeasured');
  });

  it('⛔ A NON-PUBLISHABLE METRIC RENDERS NOTHING AT ALL — not even a reason', () => {
    // § D2: a count publishes VOLUME, not skill. The rpc refuses it, so an entry point
    // here would be a control that can only fail.
    expect(renderPublishStart({ metric: metric({ publishable: false }) })).toBe('');
  });

  it('⛔⛔ A HOSTILE TAG IS ESCAPED INTO THE CONFIRM BUTTON\'S ATTRIBUTES', () => {
    // The tag is owner-typed free text and lands in `data-tag="…"`. Unescaped, a quote
    // closes the attribute and the rest is markup.
    const html = renderPublishStart({
      metric: metric(),
      pending: { tag: '" onclick="x', season_id: '1' },
    });
    expect(html).not.toContain('" onclick="x"');
    expect(html).toContain('&quot; onclick=&quot;x');
  });

  it('the confirm button carries the SAME tag and season the preview was opened with', () => {
    // ⚠ The route reads the payload back off these attributes, so a drift between what
    // the dialog SHOWS and what the button CARRIES publishes something unseen.
    const html = renderPublishStart({
      metric: metric(), pending: { tag: 'ops', season_id: '2026h2' },
    });
    expect(html).toContain('data-tag="ops"');
    expect(html).toContain('data-season="2026h2"');
    expect(html).toContain('https://recued.com/explore/ops');
  });
});

describe('D-250 § B3.3 — the send-now control', () => {
  it('⛔ NO PUBLICATIONS, NO CONTROL — there is no batch to send', () => {
    expect(renderSubmitNow({ publications: 0 })).toBe('');
  });

  it('one publication is enough', () => {
    expect(renderSubmitNow({ publications: 1 })).toContain('data-recued-submit-action');
  });
});

// ────────────────────────────────────────────────────────────────
// § B3.3 — the send-now control REPORTS what it did
// ────────────────────────────────────────────────────────────────

describe('D-250 § B3.3 — the submit outcome is rendered, not swallowed', () => {
  /** ⛔⛔ THE OUTCOME USED TO BE DISCARDED. The route ran
   *  `void submit().then(refresh, refresh)` and the screen was identical before and after
   *  — and with no board existing anywhere yet, `sent: false` was the guaranteed result,
   *  so the button was certain to do nothing visible, forever, with no explanation. */
  const REASONS = [
    'no_identity', 'no_handle', 'no_publications', 'nothing_measured', 'send_failed',
  ] as const;

  it('⛔ NO OUTCOME YET RENDERS NO STATUS — silence before the first press is correct', () => {
    const html = renderSubmitNow({ publications: 1 });
    expect(html).toContain('data-recued-submit-action');
    expect(html).not.toContain('data-recued-submit-status');
  });

  const sent = (over: Partial<{
    ranked: number; withdrawn: number; rejected: number; rejectedReasons: readonly string[];
  }> = {}) => ({
    sent: true as const, ranked: 0, withdrawn: 0, rejected: 0, rejectedReasons: [], ...over,
  });

  it('a successful send counts the boards that were UPDATED', () => {
    const html = renderSubmitNow({ publications: 1, outcome: sent({ ranked: 2 }) });
    expect(html).toContain('data-recued-submit-status="sent"');
    expect(html).toContain('2 boards updated');
  });

  it('one board is not pluralised', () => {
    expect(renderSubmitNow({ publications: 1, outcome: sent({ ranked: 1 }) }))
      .toContain('1 board updated');
  });

  /** ⛔⛔ THE DEFECT THIS SECTION NOW COVERS. The status line read "N boards answered" off
   *  `results.length`, and a rejection IS an answer — so a batch whose every entry came
   *  back `unknown_board` rendered as an unqualified success. Harmless only while no board
   *  exists to be rejected against; once they do, `unknown_board` is the ORDINARY failure
   *  for a local fork or a retired season, so the reassuring version was the common case. */
  it('⛔⛔ AN ALL-REJECTED BATCH DOES NOT READ AS SUCCESS', () => {
    const html = renderSubmitNow({
      publications: 1,
      outcome: sent({ rejected: 2, rejectedReasons: ['unknown_board'] }),
    });
    expect(html).toContain('data-recued-submit-status="rejected"');
    expect(html).toContain('Nothing was accepted');
    expect(html).toContain('unknown_board');
    // ⛔ AND IT MUST NOT LEAD WITH THE GOOD NEWS.
    expect(html).not.toContain('Sent.');
  });

  it('a mixed batch reports BOTH halves, and still counts as sent', () => {
    const html = renderSubmitNow({
      publications: 1,
      outcome: sent({ ranked: 1, rejected: 1, rejectedReasons: ['unknown_board'] }),
    });
    expect(html).toContain('data-recued-submit-status="sent"');
    expect(html).toContain('1 board updated');
    expect(html).toContain('1 entry rejected');
  });

  it('⛔ A CONFIRMED WITHDRAWAL IS REPORTED — it is what ends § C4’s retry', () => {
    const html = renderSubmitNow({ publications: 1, outcome: sent({ withdrawn: 1 }) });
    expect(html).toContain('1 withdrawal confirmed');
    expect(html).toContain('data-recued-submit-status="sent"');
  });

  it('repeated rejection reasons are said once', () => {
    const html = renderSubmitNow({
      publications: 1,
      outcome: sent({ rejected: 3, rejectedReasons: ['unknown_board'] }),
    });
    expect(html.match(/unknown_board/g) ?? []).toHaveLength(1);
    expect(html).toContain('3 entries rejected');
  });

  it('⛔ A 200 WITH NO RESULTS DOES NOT CLAIM A LANDING', () => {
    const html = renderSubmitNow({ publications: 1, outcome: sent() });
    expect(html).toContain('reported nothing back');
  });

  it('⛔⛔ EVERY SKIP REASON RENDERS ITS OWN SENTENCE — none falls through to silence', () => {
    // A missing map entry would render an empty <p>, which is the defect this replaces
    // wearing a different shape.
    const texts = new Set<string>();
    for (const reason of REASONS) {
      const html = renderSubmitNow({ publications: 1, outcome: { sent: false, reason } });
      expect(html, reason).toContain(`data-recued-submit-status="${reason}"`);
      const body = /<p class="publish-submit-status"[^>]*>([^<]+)<\/p>/.exec(html)?.[1] ?? '';
      expect(body.trim().length, reason).toBeGreaterThan(20);
      texts.add(body);
    }
    // ⛔ AND THEY ARE FIVE DIFFERENT SENTENCES. One shared string would satisfy every
    // assertion above while telling the owner nothing.
    expect(texts.size).toBe(REASONS.length);
  });

  it('⛔ ONLY send_failed READS AS A FAULT — the rest are a working server, not an error', () => {
    // § D4: publishing is never automatic, so "you have not opted in" phrased as a
    // failure would be a lie in the owner's own dashboard.
    for (const reason of ['no_identity', 'no_handle', 'no_publications', 'nothing_measured'] as const) {
      const html = renderSubmitNow({ publications: 1, outcome: { sent: false, reason } });
      expect(html.toLowerCase(), reason).not.toMatch(/\berror\b|\bfailed\b/);
    }
    // ⛔ AND IT MUST NOT PROMISE A RETRY EITHER. There is no scheduled send, so "the next
    // send will try again" would be the same false claim as the note this section removed.
    const failed = renderSubmitNow({ publications: 1, outcome: { sent: false, reason: 'send_failed' } });
    expect(failed).toContain('press send again');
    expect(failed.toLowerCase()).not.toMatch(/next send|will retry|tries again/);
  });

  it('⛔⛔ NO CLAIM OF A SCHEDULE THAT DOES NOT EXIST', () => {
    // The note used to read "Your server also sends these on its own schedule." Nothing
    // calls the submit path but this button — there is no submit housekeeping task — so
    // that sentence was a promise the product does not keep. Removed rather than reworded:
    // § B3.4 makes a scheduled submission ride a delegation rule the owner has to mint,
    // and describing it before it exists is the same defect in gentler words.
    for (const outcome of [undefined, sent({ ranked: 1 })]) {
      const html = renderSubmitNow({ publications: 1, ...(outcome ? { outcome } : {}) });
      expect(html.toLowerCase()).not.toContain('own schedule');
      expect(html.toLowerCase()).not.toContain('automatically');
    }
  });
});
