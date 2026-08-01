/** D-149 P8 § A.5.5 — approval-link config + consume validator tests. */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL,
  APPROVAL_LINK_DEFAULT_SUCCESS_MESSAGE,
  APPROVAL_LINK_OPTIONS_MAX,
  APPROVAL_LINK_PROMPT_MAX,
  APPROVAL_LINK_VISITOR_ANSWER_MAX,
  APPROVAL_LINK_VISITOR_NAME_MAX,
  APPROVAL_LINK_VISITOR_EMAIL_MAX,
  APPROVAL_LINK_VISITOR_COMMENT_MAX,
  formatApprovalLinkConsumedOutcome,
  APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION,
  APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS,
  validateApprovalLinkConfig,
  validateApprovalLinkConsume,
  type ApprovalLinkConfig,
} from '../approval-link-config.js';

const baseConfig = (overrides: Partial<ApprovalLinkConfig> = {}): ApprovalLinkConfig => ({
  display_name: 'Mary',
  action_kind: 'pick_time',
  prompt: 'Please pick a time that works for you.',
  context_raw: { summary: 'Meeting about Q3 plans.' },
  options: [
    { id: 'opt_a', label: '9am Mon' },
    { id: 'opt_b', label: '2pm Tue' },
  ],
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 7,
  on_action: {
    target_id: 'proposal-123',
    on_approve_action: 'create_commitment',
  },
  ...overrides,
});

describe('D-149 P8 § A.5.5 — validateApprovalLinkConfig', () => {
  it('accepts a well-formed pick_time config', () => {
    expect(validateApprovalLinkConfig(baseConfig())).toEqual([]);
  });

  // ⛔ An approval_link reaches the owner ONLY through a held checkpoint, and
  // only `create_commitment` creates one. `mark_resolved` / `fire_recipe` route
  // through the processor's `applyEffect` seam, which nothing supplies — so a
  // consumption sat `pending` forever while the visitor was shown a success
  // page, and the answer surfaced nowhere. D-210 Phase C also retired the fields
  // that named their targets, so neither is specifiable any more.
  describe('refuses an on_approve_action the substrate cannot honour', () => {
    for (const action of ['mark_resolved', 'fire_recipe'] as const) {
      it(`refuses ${action}, naming the remedy`, () => {
        const failures = validateApprovalLinkConfig(
          baseConfig({ on_action: { target_id: 'proposal-123', on_approve_action: action } }),
        );
        expect(failures.map((f) => f.code)).toEqual(['on_approve_action_unsupported']);
        // The message has to say what to do instead, or an owner is stuck.
        expect(failures[0]!.detail).toContain('create_commitment');
      });
    }

    // ⛔ THE PERMITTING CASE. Without it the assertions above cannot tell a
    // targeted refusal from a validator that rejects every on_approve_action.
    it('still accepts create_commitment', () => {
      expect(validateApprovalLinkConfig(
        baseConfig({ on_action: { target_id: 'proposal-123', on_approve_action: 'create_commitment' } }),
      )).toEqual([]);
    });

    // An unknown value keeps its OWN code — the two refusals are different
    // facts ("not in the vocabulary" vs "in it but unhonourable") and a caller
    // switching on the code must be able to tell them apart.
    it('keeps on_approve_action_unknown distinct from unsupported', () => {
      const failures = validateApprovalLinkConfig(
        baseConfig({
          on_action: {
            target_id: 'proposal-123',
            // @ts-expect-error -- negative fixture exercises the runtime vocabulary guard.
            on_approve_action: 'not_a_real_action',
          },
        }),
      );
      expect(failures.map((f) => f.code)).toEqual(['on_approve_action_unknown']);
    });

    // The picker and the write path derive from ONE list, so an offered option
    // the validator refuses is not expressible.
    it('offers exactly what it accepts', () => {
      for (const action of APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS) {
        expect(validateApprovalLinkConfig(
          baseConfig({ on_action: { target_id: 'proposal-123', on_approve_action: action } }),
        ), action).toEqual([]);
      }
      expect(APPROVAL_LINK_SUPPORTED_ON_APPROVE_ACTIONS)
        .toContain(APPROVAL_LINK_DEFAULT_ON_APPROVE_ACTION);
    });
  });

  it('accepts a well-formed approve_wording config (no options)', () => {
    const config: ApprovalLinkConfig = {
      ...baseConfig({ action_kind: 'approve_wording' }),
      options: undefined,
    };
    expect(validateApprovalLinkConfig(config)).toEqual([]);
  });

  it('accepts a well-formed confirm_attendance config', () => {
    const config = baseConfig({
      action_kind: 'confirm_attendance',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    });
    expect(validateApprovalLinkConfig(config)).toEqual([]);
  });

  it('accepts a well-formed answer_question config (no options)', () => {
    const config: ApprovalLinkConfig = {
      ...baseConfig({ action_kind: 'answer_question' }),
      options: undefined,
    };
    expect(validateApprovalLinkConfig(config)).toEqual([]);
  });

  it('accepts a well-formed upload_doc config (no options)', () => {
    const config: ApprovalLinkConfig = {
      ...baseConfig({ action_kind: 'upload_doc' }),
      options: undefined,
    };
    expect(validateApprovalLinkConfig(config)).toEqual([]);
  });

  it('rejects non-object config', () => {
    const failures = validateApprovalLinkConfig(null);
    expect(failures[0]?.code).toBe('config_shape_invalid');
  });

  it('rejects empty display_name', () => {
    const failures = validateApprovalLinkConfig(baseConfig({ display_name: '' }));
    expect(failures.some((f) => f.code === 'display_name_empty')).toBe(true);
  });

  it('rejects unknown action_kind', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      action_kind: 'banana',
    } as unknown);
    expect(failures.some((f) => f.code === 'action_kind_unknown')).toBe(true);
  });

  it('rejects empty prompt', () => {
    const failures = validateApprovalLinkConfig(baseConfig({ prompt: '' }));
    expect(failures.some((f) => f.code === 'prompt_empty')).toBe(true);
  });

  it('rejects overlong prompt', () => {
    const failures = validateApprovalLinkConfig(baseConfig({ prompt: 'x'.repeat(APPROVAL_LINK_PROMPT_MAX + 1) }));
    expect(failures.some((f) => f.code === 'prompt_too_long')).toBe(true);
  });

  it('rejects missing context_raw.summary', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      context_raw: { summary: '' },
    });
    expect(failures.some((f) => f.code === 'context_summary_empty')).toBe(true);
  });

  it('requires options for pick_time', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig({ action_kind: 'pick_time' }),
      options: undefined,
    });
    expect(failures.some((f) => f.code === 'options_required_for_action_kind')).toBe(true);
  });

  it('requires options for confirm_attendance', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig({ action_kind: 'confirm_attendance' }),
      options: undefined,
    });
    expect(failures.some((f) => f.code === 'options_required_for_action_kind')).toBe(true);
  });

  it('rejects options on approve_wording', () => {
    const config = {
      ...baseConfig({ action_kind: 'approve_wording' }),
      options: [{ id: 'a', label: 'A' }],
    };
    const failures = validateApprovalLinkConfig(config);
    expect(failures.some((f) => f.code === 'options_not_permitted_for_action_kind')).toBe(true);
  });

  it('rejects options on answer_question', () => {
    const config = {
      ...baseConfig({ action_kind: 'answer_question' }),
      options: [{ id: 'a', label: 'A' }],
    };
    const failures = validateApprovalLinkConfig(config);
    expect(failures.some((f) => f.code === 'options_not_permitted_for_action_kind')).toBe(true);
  });

  it('rejects options on upload_doc', () => {
    const config = {
      ...baseConfig({ action_kind: 'upload_doc' }),
      options: [{ id: 'a', label: 'A' }],
    };
    const failures = validateApprovalLinkConfig(config);
    expect(failures.some((f) => f.code === 'options_not_permitted_for_action_kind')).toBe(true);
  });

  it('rejects too-many options', () => {
    const many = Array.from({ length: APPROVAL_LINK_OPTIONS_MAX + 1 }, (_, i) => ({
      id: `o${i}`,
      label: `Option ${i}`,
    }));
    const failures = validateApprovalLinkConfig(baseConfig({ options: many }));
    expect(failures.some((f) => f.code === 'options_too_many')).toBe(true);
  });

  it('rejects duplicate option ids', () => {
    const failures = validateApprovalLinkConfig(
      baseConfig({
        options: [
          { id: 'dup', label: 'A' },
          { id: 'dup', label: 'B' },
        ],
      }),
    );
    expect(failures.some((f) => f.code === 'options_duplicate_id')).toBe(true);
  });

  it('rejects expiry_days outside [1, 30]', () => {
    expect(
      validateApprovalLinkConfig(baseConfig({ expiry_days: 0 })).some(
        (f) => f.code === 'expiry_days_out_of_range',
      ),
    ).toBe(true);
    expect(
      validateApprovalLinkConfig(baseConfig({ expiry_days: 31 })).some(
        (f) => f.code === 'expiry_days_out_of_range',
      ),
    ).toBe(true);
  });

  it('rejects unknown visitor_field name value', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      visitor_field_constraints: { name: 'omit' as 'required', email: 'required' },
    });
    expect(failures.some((f) => f.code === 'visitor_field_name_invalid')).toBe(true);
  });

  it('rejects malformed require_email_match', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      visitor_field_constraints: {
        name: 'required',
        email: 'required',
        require_email_match: 'not-an-email',
      },
    });
    expect(failures.some((f) => f.code === 'require_email_match_invalid')).toBe(true);
  });

  it('rejects missing on_action.target_id', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      on_action: {
        target_id: '',
        on_approve_action: 'create_commitment',
      },
    });
    expect(failures.some((f) => f.code === 'on_action_target_id_invalid')).toBe(true);
  });

  it('rejects unknown on_approve_action', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      on_action: {
        target_id: 'x',
        on_approve_action: 'banana' as 'create_commitment',
      },
    });
    expect(failures.some((f) => f.code === 'on_approve_action_unknown')).toBe(true);
  });

  it('rejects unknown notification_target', () => {
    const failures = validateApprovalLinkConfig({
      ...baseConfig(),
      on_action: {
        target_id: 'x',
        on_approve_action: 'create_commitment',
        notification_target: 'pigeon' as 'webclient',
      },
    });
    expect(failures.some((f) => f.code === 'notification_target_unknown')).toBe(true);
  });
});

describe('D-149 P8 § A.5.5 — validateApprovalLinkConsume', () => {
  it('accepts a well-formed pick outcome', () => {
    const config = baseConfig();
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Bob',
        visitor_email: 'bob@example.com',
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures).toEqual([]);
  });

  it('rejects pick with unknown option_id', () => {
    const config = baseConfig();
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Bob',
        visitor_email: 'bob@example.com',
        outcome: { kind: 'pick', option_id: 'nonexistent' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'option_id_unknown')).toBe(true);
  });

  it('rejects outcome kind mismatch for action_kind', () => {
    const config = baseConfig({ action_kind: 'approve_wording', options: undefined });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Bob',
        visitor_email: 'bob@example.com',
        outcome: { kind: 'pick', option_id: 'x' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'action_kind_mismatch')).toBe(true);
  });

  it('requires visitor_name when constraint says required', () => {
    const config = baseConfig({
      visitor_field_constraints: { name: 'required', email: 'optional' },
    });
    const failures = validateApprovalLinkConsume(
      { outcome: { kind: 'pick', option_id: 'opt_a' } },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_name_required')).toBe(true);
  });

  it('requires visitor_email when constraint says required', () => {
    const config = baseConfig({
      visitor_field_constraints: { name: 'optional', email: 'required' },
    });
    const failures = validateApprovalLinkConsume(
      { visitor_name: 'Bob', outcome: { kind: 'pick', option_id: 'opt_a' } },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_email_required')).toBe(true);
  });

  it('Codex P2 fold — require_email_match rejects omitted email even when email=optional', () => {
    const config = baseConfig({
      visitor_field_constraints: {
        name: 'required',
        email: 'optional',
        require_email_match: 'mom@example.com',
      },
    });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Imposter',
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_email_match_failed')).toBe(true);
  });

  it('Codex P2 fold — require_email_match rejects empty email even when email=optional', () => {
    const config = baseConfig({
      visitor_field_constraints: {
        name: 'required',
        email: 'optional',
        require_email_match: 'mom@example.com',
      },
    });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Imposter',
        visitor_email: '   ',
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_email_match_failed')).toBe(true);
  });

  it('enforces require_email_match soft-trust constraint', () => {
    const config = baseConfig({
      visitor_field_constraints: {
        name: 'required',
        email: 'required',
        require_email_match: 'mary@example.com',
      },
    });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Bob',
        visitor_email: 'bob@example.com',
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_email_match_failed')).toBe(true);
  });

  it('accepts require_email_match when email matches (case-insensitive)', () => {
    const config = baseConfig({
      visitor_field_constraints: {
        name: 'required',
        email: 'required',
        require_email_match: 'Mary@Example.com',
      },
    });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Mary',
        visitor_email: 'mary@example.com',
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures).toEqual([]);
  });

  it('accepts confirm yes/no for confirm_attendance', () => {
    const config = baseConfig({
      action_kind: 'confirm_attendance',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    });
    expect(
      validateApprovalLinkConsume(
        {
          visitor_name: 'Mom',
          visitor_email: 'mom@example.com',
          outcome: { kind: 'confirm', answer: 'yes' },
        },
        config,
      ),
    ).toEqual([]);
    expect(
      validateApprovalLinkConsume(
        {
          visitor_name: 'Mom',
          visitor_email: 'mom@example.com',
          outcome: { kind: 'confirm', answer: 'no' },
        },
        config,
      ),
    ).toEqual([]);
  });

  it('accepts approve / reject for approve_wording', () => {
    const config = baseConfig({ action_kind: 'approve_wording', options: undefined });
    expect(
      validateApprovalLinkConsume(
        {
          visitor_name: 'V',
          visitor_email: 'v@example.com',
          outcome: { kind: 'approve' },
        },
        config,
      ),
    ).toEqual([]);
    expect(
      validateApprovalLinkConsume(
        {
          visitor_name: 'V',
          visitor_email: 'v@example.com',
          outcome: { kind: 'reject', comment: 'Please revise paragraph 3.' },
        },
        config,
      ),
    ).toEqual([]);
  });

  it('rejects empty answer for answer_question', () => {
    const config = baseConfig({ action_kind: 'answer_question', options: undefined });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'V',
        visitor_email: 'v@example.com',
        outcome: { kind: 'answer', answer: '   ' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'answer_required')).toBe(true);
  });

  it('rejects overlong visitor_name', () => {
    const config = baseConfig();
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'x'.repeat(APPROVAL_LINK_VISITOR_NAME_MAX + 1),
        visitor_email: 'bob@example.com',
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_name_too_long')).toBe(true);
  });

  it('rejects overlong visitor_email', () => {
    const config = baseConfig();
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'Bob',
        visitor_email: `${'x'.repeat(APPROVAL_LINK_VISITOR_EMAIL_MAX)}@example.com`,
        outcome: { kind: 'pick', option_id: 'opt_a' },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'visitor_email_too_long')).toBe(true);
  });

  it('rejects overlong answer', () => {
    const config = baseConfig({ action_kind: 'answer_question', options: undefined });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'V',
        visitor_email: 'v@example.com',
        outcome: { kind: 'answer', answer: 'x'.repeat(APPROVAL_LINK_VISITOR_ANSWER_MAX + 1) },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'answer_too_long')).toBe(true);
  });

  it('rejects overlong reject comment', () => {
    const config = baseConfig({ action_kind: 'approve_wording', options: undefined });
    const failures = validateApprovalLinkConsume(
      {
        visitor_name: 'V',
        visitor_email: 'v@example.com',
        outcome: {
          kind: 'reject',
          comment: 'x'.repeat(APPROVAL_LINK_VISITOR_COMMENT_MAX + 1),
        },
      },
      config,
    );
    expect(failures.some((f) => f.code === 'comment_too_long')).toBe(true);
  });
});

describe('D-149 P8 § A.5.5 — formatApprovalLinkConsumedOutcome', () => {
  it('formats per spec § A.5.5 line 881 wire-shape', () => {
    expect(formatApprovalLinkConsumedOutcome({ kind: 'pick', option_id: 'a1' })).toBe('pick:a1');
    expect(formatApprovalLinkConsumedOutcome({ kind: 'approve' })).toBe('approve');
    expect(formatApprovalLinkConsumedOutcome({ kind: 'reject' })).toBe('reject');
    expect(
      formatApprovalLinkConsumedOutcome({ kind: 'reject', comment: 'needs work' }),
    ).toBe('reject:needs work');
    expect(formatApprovalLinkConsumedOutcome({ kind: 'confirm', answer: 'yes' })).toBe(
      'confirm:yes',
    );
    expect(formatApprovalLinkConsumedOutcome({ kind: 'answer', answer: 'Hello' })).toBe(
      'answer:Hello',
    );
  });
});

describe('D-149 P8 § A.5.5 — substrate defaults', () => {
  it('exports default substrate copy', () => {
    expect(APPROVAL_LINK_DEFAULT_SUBMIT_BUTTON_LABEL).toBe('Submit');
    expect(APPROVAL_LINK_DEFAULT_SUCCESS_MESSAGE.length).toBeGreaterThan(0);
  });
});
