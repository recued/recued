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
  renderStopPublishing,
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
