/** D-164 P8b — contact has-email CRM-gated deterministic "no".
 *
 *  Covers the follow-up that lets the has-email probe render the negative
 *  sibling only when the local contact store is provably complete, plus the
 *  override containment seam that keeps probe-selected bodies canonical. */

import { describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';

import {
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
  composeShortCircuitFamilies,
  createContactHasEmailProbe,
  createTemplateRenderer,
  matchContactHasEmailTemplate,
  runGate,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type DataPresenceProbe,
  type DataSnapshot,
  type GateDeps,
  type HasCrmContactSource,
  type ShortCircuitFamily,
  type TemplateRenderer,
} from '../index';
import type { SlotValue } from '../ner/index';
import type { RenderTemplate, SlotName, StructuralPlan } from '../types';

const makeSlot = (kind: SlotName, value: string, position = 0): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const nameSlot = (value = 'Pat Lee', position = 10): SlotValue =>
  makeSlot('entity.name', value, position);

const PAT_WITH_EMAIL: ContactAttributeRow = {
  name: 'Pat Lee',
  email: 'pat@example.com',
  emails: ['pat@example.com'],
};

const PAT_WITHOUT_EMAIL: ContactAttributeRow = {
  name: 'Pat Lee',
  emails: [],
};

const runProbe = async (
  opts: {
    readonly contact?: ContactAttributeLookup;
    readonly hasCrm?: HasCrmContactSource;
    readonly slots?: ReadonlyArray<SlotValue>;
  } = {},
): Promise<DataSnapshot | null> => {
  const probe = createContactHasEmailProbe(
    opts.contact ?? (() => [PAT_WITH_EMAIL]),
    opts.hasCrm ?? (() => false),
    CONTACT_HAS_NO_EMAIL_TEMPLATE,
  );
  return await probe({
    template: CONTACT_HAS_EMAIL_TEMPLATE,
    slots: opts.slots ?? [nameSlot()],
  });
};

const makeSessionEntry = (
  role: SessionEntry['role'],
  text: string,
  ts = 0,
): SessionEntry => ({
  session_id: 's',
  surface: 'chat',
  role,
  text,
  ts,
});

const makeTurnContext = (history: readonly SessionEntry[]) => {
  const resolve = vi.fn();
  const ctx = {
    surface: 'chat',
    history,
    prompt: {
      contribute: vi.fn(),
      parts: () => [],
    },
    resolve,
    state: new Map<string, unknown>(),
  } as unknown as TurnContext;

  return { ctx, resolve };
};

const hasEmailFamily = (
  probe: DataPresenceProbe,
  overrideTemplates?: readonly RenderTemplate[],
): ShortCircuitFamily => ({
  match: matchContactHasEmailTemplate,
  probe,
  templateHashes: new Set([CONTACT_HAS_EMAIL_TEMPLATE.template_hash]),
  overrideTemplates,
});

// ── Probe ───────────────────────────────────────────────────────────

describe('D-164 P8b contact has-email probe', () => {
  const render = createTemplateRenderer();

  it('YES: contact with a real email returns a frozen {name,email} snapshot and no override', async () => {
    const hasCrm = vi.fn<HasCrmContactSource>(() => true);
    const out = await runProbe({ contact: () => [PAT_WITH_EMAIL], hasCrm });

    expect(out).not.toBeNull();
    expect(out?.data).toEqual({
      name: 'Pat Lee',
      email: 'pat@example.com',
    });
    expect(Object.isFrozen(out?.data)).toBe(true);
    expect('render_template_override' in out!).toBe(false);
    expect(hasCrm).not.toHaveBeenCalled();
    expect(render(CONTACT_HAS_EMAIL_TEMPLATE, out!)).toBe(
      "Yes, Pat Lee's email address is pat@example.com.",
    );
  });

  it('NO: email absent + complete empty address set + no CRM source returns the negative override', async () => {
    const hasCrm = vi.fn<HasCrmContactSource>(() => false);
    const out = await runProbe({
      contact: () => [PAT_WITHOUT_EMAIL],
      hasCrm,
    });

    expect(hasCrm).toHaveBeenCalledTimes(1);
    expect(out).not.toBeNull();
    expect(out?.data).toEqual({ name: 'Pat Lee' });
    expect(Object.isFrozen(out?.data)).toBe(true);
    expect(out?.render_template_override).toBe(CONTACT_HAS_NO_EMAIL_TEMPLATE);
    expect(render(out!.render_template_override!, out!)).toBe(
      "No, there's no email address on file for Pat Lee.",
    );
  });

  it('defers when a CRM contact source could hold the email', async () => {
    const hasCrm = vi.fn<HasCrmContactSource>(() => true);
    await expect(runProbe({ contact: () => [PAT_WITHOUT_EMAIL], hasCrm })).resolves.toBeNull();
    expect(hasCrm).toHaveBeenCalledTimes(1);
  });

  it('defers when the CRM coverage check throws', async () => {
    const hasCrm: HasCrmContactSource = () => {
      throw new Error('coverage unavailable');
    };
    await expect(runProbe({ contact: () => [PAT_WITHOUT_EMAIL], hasCrm })).resolves.toBeNull();
  });

  it('defers when the emails field is absent (name-only tombstone sentinel)', async () => {
    const hasCrm = vi.fn<HasCrmContactSource>(() => false);
    const contact: ContactAttributeLookup = () => [{ name: 'Pat Lee' }];

    await expect(runProbe({ contact, hasCrm })).resolves.toBeNull();
    expect(hasCrm).not.toHaveBeenCalled();
  });

  it('defers when emails is non-empty while email is absent (merged-away former address)', async () => {
    const hasCrm = vi.fn<HasCrmContactSource>(() => false);
    const contact: ContactAttributeLookup = () => [
      { name: 'Pat Lee', emails: ['pat@old.example'] },
    ];

    await expect(runProbe({ contact, hasCrm })).resolves.toBeNull();
    expect(hasCrm).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', () => []],
    [
      'ambiguous',
      () => [
        { name: 'Pat Lee', emails: [] },
        { name: 'pat lee', emails: [] },
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, ContactAttributeLookup]>)(
    'defers when the contact is %s',
    async (_label, contact) => {
      const hasCrm = vi.fn<HasCrmContactSource>(() => false);
      await expect(runProbe({ contact, hasCrm })).resolves.toBeNull();
      expect(hasCrm).not.toHaveBeenCalled();
    },
  );

  it('awaits an async CRM coverage check before rendering the negative', async () => {
    const out = await runProbe({
      contact: () => [PAT_WITHOUT_EMAIL],
      hasCrm: () => Promise.resolve(false),
    });

    expect(out?.render_template_override).toBe(CONTACT_HAS_NO_EMAIL_TEMPLATE);
    expect(render(out!.render_template_override!, out!)).toBe(
      "No, there's no email address on file for Pat Lee.",
    );
  });
});

// ── Composer containment ────────────────────────────────────────────

describe('D-164 P8b composeShortCircuitFamilies override containment', () => {
  const spoofedNoTemplate: RenderTemplate = {
    ...CONTACT_HAS_NO_EMAIL_TEMPLATE,
    body: 'Spoofed no-email body for {{name}}.',
  };

  it('drops a snapshot when the owning family did not declare overrideTemplates', async () => {
    const probe: DataPresenceProbe = () => ({
      data: { name: 'Pat Lee' },
      render_template_override: CONTACT_HAS_NO_EMAIL_TEMPLATE,
    });
    const { probeData } = composeShortCircuitFamilies([hasEmailFamily(probe)]);

    await expect(probeData({
      template: CONTACT_HAS_EMAIL_TEMPLATE,
      slots: [nameSlot()],
    })).resolves.toBeNull();
  });

  it('substitutes the canonical declared override object for a probe-supplied body with the same hash', async () => {
    const probe: DataPresenceProbe = () => ({
      data: { name: 'Pat Lee' },
      render_template_override: spoofedNoTemplate,
    });
    const { probeData } = composeShortCircuitFamilies([
      hasEmailFamily(probe, [CONTACT_HAS_NO_EMAIL_TEMPLATE]),
    ]);
    const render = createTemplateRenderer();

    const out = await probeData({
      template: CONTACT_HAS_EMAIL_TEMPLATE,
      slots: [nameSlot()],
    });

    expect(out).not.toBeNull();
    expect(out?.render_template_override).toBe(CONTACT_HAS_NO_EMAIL_TEMPLATE);
    expect(out?.render_template_override?.body).toBe(CONTACT_HAS_NO_EMAIL_TEMPLATE.body);
    expect(render(out!.render_template_override!, out!)).toBe(
      "No, there's no email address on file for Pat Lee.",
    );
  });

  it('drops a snapshot with an undeclared override hash', async () => {
    const undeclared: RenderTemplate = {
      ...CONTACT_HAS_NO_EMAIL_TEMPLATE,
      template_hash: 'recued/contact-has-no-email-by-name@spoof',
    };
    const probe: DataPresenceProbe = () => ({
      data: { name: 'Pat Lee' },
      render_template_override: undeclared,
    });
    const { probeData } = composeShortCircuitFamilies([
      hasEmailFamily(probe, [CONTACT_HAS_NO_EMAIL_TEMPLATE]),
    ]);

    await expect(probeData({
      template: CONTACT_HAS_EMAIL_TEMPLATE,
      slots: [nameSlot()],
    })).resolves.toBeNull();
  });
});

// ── runGate ─────────────────────────────────────────────────────────

describe('D-164 P8b runGate with has-email overrides', () => {
  it('end-to-end renders the authorized negative override through ctx.resolve', async () => {
    const probe = createContactHasEmailProbe(
      () => [PAT_WITHOUT_EMAIL],
      () => false,
      CONTACT_HAS_NO_EMAIL_TEMPLATE,
    );
    const composed = composeShortCircuitFamilies([
      hasEmailFamily(probe, [CONTACT_HAS_NO_EMAIL_TEMPLATE]),
    ]);
    const deps: GateDeps = {
      ...composed,
      renderTemplate: createTemplateRenderer(),
    };
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', "Do I have Pat Lee's email?", 1),
    ]);

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'short-circuit',
      text: "No, there's no email address on file for Pat Lee.",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      "No, there's no email address on file for Pat Lee.",
    );
  });

  it.each([
    [
      'short_circuit_eligible false',
      {
        ...CONTACT_HAS_NO_EMAIL_TEMPLATE,
        short_circuit_eligible: false,
      } as unknown as RenderTemplate,
    ],
    [
      'structural_plan kind',
      ({
        template_hash: CONTACT_HAS_NO_EMAIL_TEMPLATE.template_hash,
        kind: 'structural_plan',
        slot_grammar: ['entity.name'],
        action_class: 'read',
        short_circuit_eligible: false,
      } satisfies StructuralPlan) as unknown as RenderTemplate,
    ],
  ])('passes through when an override bypasses types with %s', async (_label, override) => {
    const renderTemplate = vi.fn<TemplateRenderer>(() => {
      throw new Error('renderTemplate must not run for invalid overrides');
    });
    const deps: GateDeps = {
      matchTemplate: () => CONTACT_HAS_EMAIL_TEMPLATE,
      probeData: () => ({
        data: { name: 'Pat Lee' },
        render_template_override: override,
      }),
      renderTemplate,
    };
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', "Do I have Pat Lee's email?", 1),
    ]);

    await expect(runGate(ctx, deps)).resolves.toEqual({
      kind: 'pass-through',
      reason: 'no-data-presence',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(renderTemplate).not.toHaveBeenCalled();
  });
});
