/** D-192 M4c-UI — the messenger "Message triggers" editor (ui-shared half).
 *
 *  Covers the pure substrate the render + host share: the flat-values reader
 *  (`collectMatchPatternRows`), the compile (`matchPatternRowsToPatterns`), the
 *  render (the slack/telegram form grows a trigger editor; the mode sub-control
 *  rides only a content row), the client validation (half-filled / bad grammar
 *  / empty-is-valid), and the projection EXCLUSION (the field never leaks into
 *  the enroll/update `config` — it saves via `setMatchPatterns`). */

import { describe, expect, it } from 'vitest';

import {
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  isCompleteMatchPatternRow,
  isHalfFilledMatchPatternRow,
  renderConnectionsPage,
  validateConnectionForm,
  projectConnectionPayload,
  resolveConnectionSchema,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  type ConnectionsPageState,
  type ConnectionsDialogState,
  type ConnectionSchema,
} from '@recued/ui-shared';

const slackSchema = (): ConnectionSchema => {
  const s = resolveConnectionSchema('notification', 'slack');
  if (!s) throw new Error('slack schema missing');
  return s;
};

const baseState = (): ConnectionsPageState => initialConnectionsPageState();

const slackForm = (values: Record<string, string>): string =>
  renderConnectionsPage({
    ...baseState(),
    dialog: {
      ...initialConnectionsDialogState(),
      stage: 'form',
      kind: 'notification',
      subtype: 'slack',
      values,
    } as ConnectionsDialogState,
  });

describe('D-192 M4c-UI — collectMatchPatternRows', () => {
  it('reads flat kind/value/mode keys into sorted rows', () => {
    const rows = collectMatchPatternRows(
      {
        'config.match_patterns.1.kind': 'content',
        'config.match_patterns.1.value': 'send',
        'config.match_patterns.1.mode': 'word',
        'config.match_patterns.0.kind': 'tag',
        'config.match_patterns.0.value': 'commit',
        'unrelated.key': 'x',
      },
      'config.match_patterns',
    );
    expect(rows).toEqual([
      { index: 0, kind: 'tag', value: 'commit', mode: '' },
      { index: 1, kind: 'content', value: 'send', mode: 'word' },
    ]);
  });

  it('returns [] for no rows', () => {
    expect(collectMatchPatternRows({ 'config.channel_id': 'C1' }, 'config.match_patterns')).toEqual([]);
  });
});

describe('D-192 M4c-UI — matchPatternRowsToPatterns', () => {
  it('compiles complete rows and drops incomplete ones', () => {
    const patterns = matchPatternRowsToPatterns([
      { index: 0, kind: 'tag', value: '  commit ', mode: '' },
      { index: 1, kind: 'mention', value: 'anna', mode: '' },
      { index: 2, kind: 'content', value: 'I will send', mode: 'word' },
      { index: 3, kind: 'content', value: 'ping', mode: '' }, // no mode → omitted
      { index: 4, kind: '', value: 'orphan-value', mode: '' }, // no kind → dropped
      { index: 5, kind: 'tag', value: '   ', mode: '' }, // no value → dropped
    ]);
    expect(patterns).toEqual([
      { kind: 'tag', value: 'commit' },
      { kind: 'mention', value: 'anna' },
      { kind: 'content', value: 'I will send', mode: 'word' },
      { kind: 'content', value: 'ping' },
    ]);
  });

  it('classifies complete / half-filled rows', () => {
    expect(isCompleteMatchPatternRow({ index: 0, kind: 'tag', value: 'x', mode: '' })).toBe(true);
    expect(isHalfFilledMatchPatternRow({ index: 0, kind: 'tag', value: '', mode: '' })).toBe(true);
    expect(isHalfFilledMatchPatternRow({ index: 0, kind: '', value: 'x', mode: '' })).toBe(true);
    expect(isHalfFilledMatchPatternRow({ index: 0, kind: '', value: '', mode: '' })).toBe(false);
  });
});

describe('D-192 M4c-UI — render', () => {
  it('grows a Message triggers editor on the slack form (kind select + Add + Remove)', () => {
    const html = slackForm({ 'config.channel_id': 'C1' });
    expect(html).toContain('Message triggers');
    expect(html).toContain('connections-matchpattern-kind');
    expect(html).toContain('+ Add trigger');
    expect(html).toContain('connections-add-pattern');
    expect(html).toContain('connections-remove-pattern');
    // The kind select carries the four options (placeholder + three kinds).
    expect(html).toContain('#tag');
    expect(html).toContain('@mention');
    expect(html).toContain('Keyword text');
  });

  it('shows the mode select ONLY for a content row', () => {
    const contentRow = slackForm({
      'config.match_patterns.0.kind': 'content',
      'config.match_patterns.0.value': 'send',
    });
    expect(contentRow).toContain('connections-matchpattern-mode');

    const tagRow = slackForm({
      'config.match_patterns.0.kind': 'tag',
      'config.match_patterns.0.value': 'commit',
    });
    expect(tagRow).not.toContain('connections-matchpattern-mode');
  });
});

describe('D-192 M4c-UI — validateConnectionForm', () => {
  const validate = (values: Record<string, string>): string | null =>
    validateConnectionForm(
      slackSchema(),
      {
        name: 'slack',
        display_name: 'Slack',
        'config.channel_id': 'C1',
        'auth.type': 'bearer',
        'auth.token': 'xoxb-x',
        ...values,
      },
      undefined,
      'edit',
    );

  it('accepts an empty trigger list (optional)', () => {
    expect(validate({})).toBeNull();
    expect(
      validate({ 'config.match_patterns.0.kind': '', 'config.match_patterns.0.value': '' }),
    ).toBeNull();
  });

  it('accepts well-formed triggers', () => {
    expect(
      validate({
        'config.match_patterns.0.kind': 'tag',
        'config.match_patterns.0.value': 'commit',
        'config.match_patterns.1.kind': 'content',
        'config.match_patterns.1.value': 'I will send',
        'config.match_patterns.1.mode': 'word',
      }),
    ).toBeNull();
  });

  it('rejects a half-filled row', () => {
    expect(
      validate({ 'config.match_patterns.0.kind': 'tag', 'config.match_patterns.0.value': '' }),
    ).toMatch(/each trigger needs both a type and a value/);
    expect(
      validate({ 'config.match_patterns.0.kind': '', 'config.match_patterns.0.value': 'orphan' }),
    ).toMatch(/each trigger needs both a type and a value/);
  });

  it('rejects a tag token the matcher grammar could never produce', () => {
    expect(
      validate({ 'config.match_patterns.0.kind': 'tag', 'config.match_patterns.0.value': 'two words' }),
    ).toMatch(/Message triggers:/);
  });
});

describe('D-192 M4c-UI — projection EXCLUDES the triggers from config', () => {
  it('never leaks the match-pattern rows into the enroll/update config', () => {
    const payload = projectConnectionPayload(
      slackSchema(),
      {
        name: 'slack',
        display_name: 'Slack',
        'config.channel_id': 'C1',
        'auth.type': 'bearer',
        'auth.token': 'xoxb-x',
        'config.match_patterns.0.kind': 'tag',
        'config.match_patterns.0.value': 'commit',
      },
      'notification',
      'slack',
    );
    expect(payload.config.channel_id).toBe('C1');
    // The triggers are saved via setMatchPatterns, NOT config.
    expect('match_patterns' in payload.config).toBe(false);
    expect(payload.config['match_patterns.0.kind']).toBeUndefined();
  });
});
