/** D-151 P2 — `proposedEndpointConfigToAuthoringSeed` acceptance.
 *
 *  The converter is the SECURITY BOUNDARY between the AI-drafted
 *  `ProposedEndpointConfig` (wide field-type union) and the public-
 *  substrate authoring config (closed field-type enum). The load-bearing
 *  assertions: forbidden field types (`password` / `signature` /
 *  `trusted_html` / `ref<...>`) are dropped so they can never reach the
 *  visitor substrate; field name / label / required survive; the three
 *  authoring kinds map their sub-configs; an absent sub-config returns a
 *  minimal config. */

import { describe, expect, it } from 'vitest';

import { proposedEndpointConfigToAuthoringSeed } from '../compose/to-authoring-seed.js';
import type {
  ProposedEndpointConfig,
  ProposedFormField,
} from '../compose/types.js';

// ── Fixtures ──────────────────────────────────────────────────────

const baseConfig = (
  over: Partial<ProposedEndpointConfig>,
): ProposedEndpointConfig => ({
  version: '1.0.0',
  kind: 'intake_form',
  title: 'Speaker bios',
  expiry_policy: { mode: 'never' },
  exposure_intent: 'public_anonymous',
  source_path: 'intent',
  ...over,
});

const field = (over: Partial<ProposedFormField>): ProposedFormField => ({
  name: 'your_name',
  type: 'text',
  label: 'Your name',
  required: true,
  ...over,
});

// ══════════════════════════════════════════════════════════════════
// intake_form — the security boundary
// ══════════════════════════════════════════════════════════════════

describe('proposedEndpointConfigToAuthoringSeed — intake_form', () => {
  it('maps form_definition + title/description/labels/required', () => {
    const proposed = baseConfig({
      kind: 'intake_form',
      title: 'Bio intake',
      description: 'Tell us about yourself.',
      form_definition: {
        form_definition_id: 'fd_bio',
        submit_button_label: 'Send',
        success_message: 'Got it!',
        email_requirement: 'required',
        fields: [
          field({ name: 'your_name', type: 'text', label: 'Your name', required: true }),
          field({ name: 'bio', type: 'textarea', label: 'Short bio', required: false }),
        ],
      },
    });
    const seed = proposedEndpointConfigToAuthoringSeed(proposed);
    expect(seed.kind).toBe('intake_form');
    const c = seed.config as Record<string, any>;
    expect(c.display_name).toBe('Bio intake');
    expect(c.instructions).toBe('Tell us about yourself.');
    expect(c.submit_button_label).toBe('Send');
    expect(c.success_message).toBe('Got it!');
    expect(c.required_visitor_fields).toEqual({ email: 'required' });
    expect(c.form_definition.form_definition_id).toBe('fd_bio');
    expect(c.form_definition.fields).toEqual([
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      { name: 'bio', type: 'textarea', label: 'Short bio', required: false },
    ]);
  });

  it('DROPS forbidden field types (password / signature / trusted_html / ref<...>)', () => {
    const proposed = baseConfig({
      kind: 'intake_form',
      form_definition: {
        form_definition_id: 'fd_x',
        fields: [
          field({ name: 'ok_text', type: 'text', label: 'OK', required: true }),
          field({ name: 'secret', type: 'password', label: 'Password', required: true }),
          field({ name: 'sign', type: 'signature', label: 'Sign here', required: false }),
          field({ name: 'html', type: 'trusted_html', label: 'HTML', required: false }),
          field({ name: 'linked', type: 'ref<contact>', label: 'Linked', required: false }),
          field({ name: 'also_ok', type: 'enum', label: 'Pick', required: false, values: ['a', 'b'] }),
        ],
      },
    });
    const seed = proposedEndpointConfigToAuthoringSeed(proposed);
    const c = seed.config as Record<string, any>;
    const names = c.form_definition.fields.map((f: { name: string }) => f.name);
    // Only the public-substrate-safe field types survive.
    expect(names).toEqual(['ok_text', 'also_ok']);
    // None of the forbidden types leak through.
    const types = c.form_definition.fields.map((f: { type: string }) => f.type);
    expect(types).not.toContain('password');
    expect(types).not.toContain('signature');
    expect(types).not.toContain('trusted_html');
    expect(types.some((t: string) => t.startsWith('ref<'))).toBe(false);
    // The surviving enum keeps its values.
    expect(c.form_definition.fields[1]).toEqual({
      name: 'also_ok',
      type: 'enum',
      label: 'Pick',
      required: false,
      values: ['a', 'b'],
    });
  });

  it('keeps an empty fields list when dropping leaves zero (user adds one)', () => {
    const proposed = baseConfig({
      kind: 'intake_form',
      form_definition: {
        form_definition_id: 'fd_empty',
        fields: [
          field({ name: 'secret', type: 'password', label: 'Password', required: true }),
          field({ name: 'linked', type: 'ref<deal>', label: 'Linked', required: false }),
        ],
      },
    });
    const c = proposedEndpointConfigToAuthoringSeed(proposed).config as Record<string, any>;
    expect(c.form_definition.fields).toEqual([]);
  });

  it('never maps visitor_pii_class into the config', () => {
    const proposed = baseConfig({
      kind: 'intake_form',
      form_definition: {
        form_definition_id: 'fd_pii',
        fields: [
          field({
            name: 'your_name',
            type: 'text',
            label: 'Your name',
            required: true,
            visitor_pii_class: 'visitor_name',
          }),
        ],
      },
    });
    const c = proposedEndpointConfigToAuthoringSeed(proposed).config as Record<string, any>;
    expect(c.form_definition.fields[0]).not.toHaveProperty('visitor_pii_class');
  });

  it('absent form_definition → minimal title-only config', () => {
    const proposed = baseConfig({ kind: 'intake_form', title: 'Bare', form_definition: undefined });
    const seed = proposedEndpointConfigToAuthoringSeed(proposed);
    expect(seed.kind).toBe('intake_form');
    expect(seed.config).toEqual({ display_name: 'Bare' });
  });
});

// ══════════════════════════════════════════════════════════════════
// scheduling_link
// ══════════════════════════════════════════════════════════════════

describe('proposedEndpointConfigToAuthoringSeed — scheduling_link', () => {
  it('maps the scheduling sub-config keys', () => {
    const proposed = baseConfig({
      kind: 'scheduling_link',
      title: 'Book a chat',
      scheduling: {
        display_name: 'Chat with me',
        instructions: 'Pick a slot.',
        success_message: 'Booked!',
        duration_options_minutes: [30, 60],
        available_window_definition: { tz: 'America/New_York', explicit_windows: [] },
        required_visitor_fields: { email: 'required' },
        min_advance_notice_hours: 24,
        max_lead_time_days: 30,
        max_bookings_per_day: 5,
        on_booking: { create_calendar_event: true },
      },
    });
    const seed = proposedEndpointConfigToAuthoringSeed(proposed);
    expect(seed.kind).toBe('scheduling_link');
    const c = seed.config as Record<string, any>;
    expect(c.display_name).toBe('Chat with me');
    expect(c.instructions).toBe('Pick a slot.');
    expect(c.success_message).toBe('Booked!');
    expect(c.duration_options_minutes).toEqual([30, 60]);
    expect(c.available_window_definition).toEqual({
      tz: 'America/New_York',
      explicit_windows: [],
    });
    expect(c.required_visitor_fields).toEqual({ email: 'required' });
    expect(c.min_advance_notice_hours).toBe(24);
    expect(c.max_lead_time_days).toBe(30);
    expect(c.max_bookings_per_day).toBe(5);
    expect(c.on_booking).toEqual({ create_calendar_event: true });
  });

  it('falls back to the title for display_name', () => {
    const proposed = baseConfig({
      kind: 'scheduling_link',
      title: 'Default name',
      scheduling: {
        duration_options_minutes: [30],
        available_window_definition: { tz: 'UTC' },
      },
    });
    const c = proposedEndpointConfigToAuthoringSeed(proposed).config as Record<string, any>;
    expect(c.display_name).toBe('Default name');
  });

  it('absent scheduling → minimal title-only config', () => {
    const proposed = baseConfig({ kind: 'scheduling_link', title: 'Bare', scheduling: undefined });
    expect(proposedEndpointConfigToAuthoringSeed(proposed).config).toEqual({
      display_name: 'Bare',
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// reception_page
// ══════════════════════════════════════════════════════════════════

describe('proposedEndpointConfigToAuthoringSeed — reception_page', () => {
  it('maps the page_layout keys + seeds display_name from title', () => {
    const proposed = baseConfig({
      kind: 'reception_page',
      title: 'My desk',
      page_layout: {
        display_overrides: { tagline: 'Reach me here' },
        sections_enabled: { contact_card: true },
        custom_links: [{ label: 'Site', url: 'https://example.com' }],
        trust_footer_enabled: false,
      },
    });
    const seed = proposedEndpointConfigToAuthoringSeed(proposed);
    expect(seed.kind).toBe('reception_page');
    const c = seed.config as Record<string, any>;
    expect(c.display_overrides.display_name).toBe('My desk');
    expect(c.display_overrides.tagline).toBe('Reach me here');
    expect(c.sections_enabled).toEqual({ contact_card: true });
    expect(c.custom_links).toEqual([{ label: 'Site', url: 'https://example.com' }]);
    expect(c.trust_footer_enabled).toBe(false);
  });

  it('absent page_layout → minimal display_name-only config', () => {
    const proposed = baseConfig({
      kind: 'reception_page',
      title: 'Bare',
      page_layout: undefined,
    });
    expect(proposedEndpointConfigToAuthoringSeed(proposed).config).toEqual({
      display_overrides: { display_name: 'Bare' },
    });
  });
});
