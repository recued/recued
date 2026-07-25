/** D-149 P2 § A.4 — `buildReceptionPacket` wrapper.
 *
 *  Acceptance per spec § A.4:
 *    - Per-kind build round-trip through `buildRedactedPacket` returns
 *      a `ReceptionRedactedPacket<K>` with no `access_token` field
 *      (spec line 536 "never embed token in built packet").
 *    - The audit-emit seam carries `endpoint_id` + `packet_kind` in
 *      the context payload; the wrapper-supplied seam returns the
 *      audit row's activity_id which the wrapper stamps on the
 *      envelope as `audit_target_id`.
 *    - When the substrate's emit seam does not return an activity_id,
 *      the wrapper falls back to `endpoint.endpoint_id` as the
 *      audit pointer so the envelope is never lacking the field.
 *    - kind/context-mismatch raises `ReceptionPacketValidationError`.
 *    - No-leak structural test on a synthetic raw with extra fields
 *      (per spec § A.4 boundary contract).
 *    - Substrate self-check (`assertReceptionPacketInvariants`) passes
 *      against the closed-list `RECEPTION_PACKET_KINDS`.
 *    - Handler registry has an entry for every kind +
 *      `assertReceptionHandlerRegistryComplete` passes.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RedactedPacketBuildAuditEvent } from '@recued/contracts';
import {
  RECEPTION_PACKET_KINDS,
  ReceptionPacketValidationError,
  assertReceptionPacketInvariants,
  buildReceptionPacket,
  isReceptionPacketKind,
  type BuildReceptionPacketOptions,
  type ReceptionEndpointContext,
} from '../ports/reception/redacted-packet.js';
import {
  RECEPTION_KIND_HANDLERS,
  assertReceptionHandlerRegistryComplete,
} from '../ports/reception/handlers/index.js';

const FIXED_NOW = 1_715_000_000_000;
const FIXED_TOKEN = 'fixed-token';

const buildOpts = (
  patch: Partial<BuildReceptionPacketOptions> = {},
): BuildReceptionPacketOptions => ({
  now: FIXED_NOW,
  randomToken: () => FIXED_TOKEN,
  ...patch,
});

const endpointCtx = (
  kind: ReceptionEndpointContext['kind'],
  patch: Partial<ReceptionEndpointContext> = {},
): ReceptionEndpointContext => ({
  endpoint_id: `ep-${kind}`,
  kind,
  expires_at: FIXED_NOW + 7 * 24 * 60 * 60 * 1000,
  ...patch,
});

const receptionPageRaw = () => ({
  display_name: 'Mary Smith',
  tagline: 'Reach me here',
  preferred_contact_methods: ['email' as const, 'phone' as const],
  tz_label: 'America/Los_Angeles',
});

const schedulingLinkRaw = () => ({
  calendar_events: [],
  window_start: FIXED_NOW,
  window_end: FIXED_NOW + 24 * 60 * 60 * 1000,
  tz: 'America/Los_Angeles',
  duration_options: [30],
  required_visitor_fields: {
    name: 'required' as const,
    email: 'required' as const,
    topic: 'optional' as const,
    phone: 'omit' as const,
    notes: 'omit' as const,
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
});

const intakeFormRaw = () => ({
  form_definition: {
    form_definition_id: 'fd-1',
    visitor_visible_fields: [
      { name: 'name', type: 'text' as const, label: 'Name', required: true },
    ],
  },
  required_fields: ['name'],
  optional_fields: [],
  submit_button_label: 'Send',
  success_message_template: 'Got it.',
  rate_limit_hint: '10/hour',
});

const dropLinkRaw = () => ({
  size_cap_bytes: 100 * 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  instructions: 'Upload the contract',
  required_visitor_fields: {
    name: 'required' as const,
    email: 'required' as const,
    description: 'optional' as const,
  },
  one_time_use: true,
  expiry_display: 'Expires in 7 days',
});

const approvalLinkRaw = () => ({
  action_kind: 'pick_time' as const,
  prompt: 'Pick a time',
  options: [{ id: 'a', label: 'Tuesday 10am' }],
  expiry_display: '48h',
  visitor_field_constraints: { name: 'required' as const, email: 'required' as const },
  context_raw: { summary: 'Quick chat?' },
});

const statusLinkRaw = () => ({
  projection_kind: 'project' as const,
  source_entity_row: { title: 'Trip', state: 'active' },
  last_updated_at: FIXED_NOW - 60 * 60 * 1000,
  now: FIXED_NOW,
  updates_visible: true,
  comments_enabled: false,
});

// ── Closed-list discipline ──────────────────────────────────────────

describe('D-149 P2 — RECEPTION_PACKET_KINDS closed list', () => {
  it('contains the six spec-declared reception kinds in spec order', () => {
    expect([...RECEPTION_PACKET_KINDS]).toEqual([
      'reception_page_packet',
      'scheduling_link_packet',
      'intake_form_packet',
      'drop_link_packet',
      'approval_link_packet',
      'status_link_packet',
    ]);
  });

  it('isReceptionPacketKind accepts every member + rejects unknown', () => {
    for (const kind of RECEPTION_PACKET_KINDS) {
      expect(isReceptionPacketKind(kind)).toBe(true);
    }
    expect(isReceptionPacketKind('availability')).toBe(false); // D-145 kind, not reception
    expect(isReceptionPacketKind('unknown')).toBe(false);
    expect(isReceptionPacketKind(null)).toBe(false);
    expect(isReceptionPacketKind(42)).toBe(false);
  });

  it('assertReceptionPacketInvariants passes', () => {
    expect(() => assertReceptionPacketInvariants()).not.toThrow();
  });
});

// ── Per-kind round-trip build through the wrapper ───────────────────

describe('D-149 P2 — buildReceptionPacket per-kind round-trip', () => {
  it('reception_page_packet builds + strips access_token', () => {
    const packet = buildReceptionPacket(
      'reception_page_packet',
      receptionPageRaw(),
      endpointCtx('reception_page_packet'),
      buildOpts(),
    );
    expect(packet.packet_kind).toBe('reception_page_packet');
    expect(Object.prototype.hasOwnProperty.call(packet, 'access_token')).toBe(false);
    expect(packet.payload.display_name).toBe('Mary Smith');
  });

  it('scheduling_link_packet builds + strips access_token', () => {
    const packet = buildReceptionPacket(
      'scheduling_link_packet',
      schedulingLinkRaw(),
      endpointCtx('scheduling_link_packet'),
      buildOpts(),
    );
    expect(packet.packet_kind).toBe('scheduling_link_packet');
    expect(Object.prototype.hasOwnProperty.call(packet, 'access_token')).toBe(false);
    expect(packet.payload.free_windows.length).toBe(1);
  });

  it('intake_form_packet builds + strips access_token', () => {
    const packet = buildReceptionPacket(
      'intake_form_packet',
      intakeFormRaw(),
      endpointCtx('intake_form_packet'),
      buildOpts(),
    );
    expect(packet.packet_kind).toBe('intake_form_packet');
    expect(Object.prototype.hasOwnProperty.call(packet, 'access_token')).toBe(false);
    expect(packet.payload.form_definition.form_definition_id).toBe('fd-1');
  });

  it('drop_link_packet builds + strips access_token', () => {
    const packet = buildReceptionPacket(
      'drop_link_packet',
      dropLinkRaw(),
      endpointCtx('drop_link_packet'),
      buildOpts(),
    );
    expect(packet.packet_kind).toBe('drop_link_packet');
    expect(Object.prototype.hasOwnProperty.call(packet, 'access_token')).toBe(false);
  });

  it('approval_link_packet builds + strips access_token + redacts context', () => {
    const packet = buildReceptionPacket(
      'approval_link_packet',
      approvalLinkRaw(),
      endpointCtx('approval_link_packet'),
      buildOpts(),
    );
    expect(packet.packet_kind).toBe('approval_link_packet');
    expect(Object.prototype.hasOwnProperty.call(packet, 'access_token')).toBe(false);
    expect(packet.payload.context_summary).toBe('Quick chat?');
  });

  it('status_link_packet builds + strips access_token', () => {
    const packet = buildReceptionPacket(
      'status_link_packet',
      statusLinkRaw(),
      endpointCtx('status_link_packet'),
      buildOpts(),
    );
    expect(packet.packet_kind).toBe('status_link_packet');
    expect(Object.prototype.hasOwnProperty.call(packet, 'access_token')).toBe(false);
  });
});

// ── Audit emission ──────────────────────────────────────────────────

describe('D-149 P2 — audit emission carries endpoint_id + kind context', () => {
  it('emitAudit fires once per build with endpoint_id + packet_kind in context', () => {
    const events: RedactedPacketBuildAuditEvent[] = [];
    const emitAudit = vi.fn((event: RedactedPacketBuildAuditEvent) => {
      events.push(event);
      return 'audit-row-1';
    });

    const packet = buildReceptionPacket(
      'reception_page_packet',
      receptionPageRaw(),
      endpointCtx('reception_page_packet', { endpoint_id: 'ep-page-abc' }),
      buildOpts({ emitAudit }),
    );

    expect(emitAudit).toHaveBeenCalledTimes(1);
    expect(events[0]!.packet_kind).toBe('reception_page_packet');
    expect(events[0]!.fields_visible).toContain('display_name');
    expect(events[0]!.context).toEqual({
      endpoint_id: 'ep-page-abc',
      packet_kind: 'reception_page_packet',
    });
    expect(packet.audit_target_id).toBe('audit-row-1');
  });

  it('falls back to endpoint.endpoint_id as audit_target_id when emit returns undefined', () => {
    const emitAudit = vi.fn(() => undefined);
    const packet = buildReceptionPacket(
      'drop_link_packet',
      dropLinkRaw(),
      endpointCtx('drop_link_packet', { endpoint_id: 'ep-drop-xyz' }),
      buildOpts({ emitAudit }),
    );
    expect(packet.audit_target_id).toBe('ep-drop-xyz');
  });

  it('falls back to endpoint.endpoint_id when no emitAudit is supplied', () => {
    const packet = buildReceptionPacket(
      'status_link_packet',
      statusLinkRaw(),
      endpointCtx('status_link_packet', { endpoint_id: 'ep-status-1' }),
      buildOpts(),
    );
    expect(packet.audit_target_id).toBe('ep-status-1');
  });

  it('merges caller-supplied audit_context but cannot override endpoint_id / packet_kind', () => {
    const events: RedactedPacketBuildAuditEvent[] = [];
    const emitAudit = (event: RedactedPacketBuildAuditEvent) => {
      events.push(event);
      return 'row';
    };
    buildReceptionPacket(
      'intake_form_packet',
      intakeFormRaw(),
      endpointCtx('intake_form_packet', {
        endpoint_id: 'real-endpoint',
        audit_context: {
          // Reserved keys — must be ignored
          endpoint_id: 'attacker-endpoint',
          packet_kind: 'availability',
          // Caller-supplied extras — must be merged
          form_template_ref: 'foundation-pack:vendor-inquiry',
          revision: 3,
        },
      }),
      buildOpts({ emitAudit }),
    );
    expect(events[0]!.context).toEqual({
      endpoint_id: 'real-endpoint',
      packet_kind: 'intake_form_packet',
      form_template_ref: 'foundation-pack:vendor-inquiry',
      revision: 3,
    });
  });
});

// ── Wrapper-level validation ────────────────────────────────────────

describe('D-149 P2 — wrapper-level invariants', () => {
  it('throws ReceptionPacketValidationError when endpoint.kind does not match build kind', () => {
    expect(() =>
      buildReceptionPacket(
        'reception_page_packet',
        receptionPageRaw(),
        endpointCtx('scheduling_link_packet'), // mismatch
        buildOpts(),
      ),
    ).toThrow(ReceptionPacketValidationError);
  });

  it('opts.expires_at overrides endpoint.expires_at when both are set', () => {
    const explicit = FIXED_NOW + 2 * 60 * 60 * 1000; // 2 hours
    const packet = buildReceptionPacket(
      'reception_page_packet',
      receptionPageRaw(),
      endpointCtx('reception_page_packet', { expires_at: FIXED_NOW + 7 * 24 * 60 * 60 * 1000 }),
      buildOpts({ expires_at: explicit }),
    );
    expect(packet.expires_at).toBe(explicit);
  });

  it('endpoint.expires_at flows through to the envelope when opts.expires_at is unset', () => {
    const exp = FIXED_NOW + 3 * 24 * 60 * 60 * 1000;
    const packet = buildReceptionPacket(
      'reception_page_packet',
      receptionPageRaw(),
      endpointCtx('reception_page_packet', { expires_at: exp }),
      buildOpts(),
    );
    expect(packet.expires_at).toBe(exp);
  });
});

// ── No-leak structural test ─────────────────────────────────────────

describe('D-149 P2 — no-leak structural test', () => {
  it('synthetic raw with extra private fields → only fields_visible reach the payload', () => {
    // Spec § A.4 boundary contract: raw input may carry private
    // fields (e.g., calendar event titles, private notes); the
    // closed-list pick + per-kind transform MUST guarantee they
    // never reach the visitor envelope.
    const richRaw = {
      ...schedulingLinkRaw(),
      // Sensitive extras that should NEVER appear
      calendar_events: [
        // Event objects carry start_at / end_at by contract; extras
        // on individual events are dropped by computeFreeWindows
        // because the transform only reads start_at / end_at.
        { start_at: FIXED_NOW + 1000, end_at: FIXED_NOW + 2000 } as never,
      ],
      vault_refs: ['vault.api.openai'],
      private_notes: ['Met at MIT in 2019'],
      internal_classification: 'vendor_high_value',
    };
    const packet = buildReceptionPacket(
      'scheduling_link_packet',
      richRaw as never,
      endpointCtx('scheduling_link_packet'),
      buildOpts(),
    );
    const payloadJson = JSON.stringify(packet.payload);
    expect(payloadJson).not.toContain('vault_refs');
    expect(payloadJson).not.toContain('private_notes');
    expect(payloadJson).not.toContain('internal_classification');
    expect(payloadJson).not.toContain('Met at MIT');
  });

  it('approval context_raw fields stay server-side (counterparty_aliases + private_notes)', () => {
    const packet = buildReceptionPacket(
      'approval_link_packet',
      {
        ...approvalLinkRaw(),
        context_raw: {
          summary: 'Confirm meeting.',
          counterparty_aliases: ['alias:bigco', 'alias:vendor-1'],
          private_notes: ['Bad faith last time'],
        },
      },
      endpointCtx('approval_link_packet'),
      buildOpts(),
    );
    const payloadJson = JSON.stringify(packet.payload);
    expect(payloadJson).not.toContain('alias:bigco');
    expect(payloadJson).not.toContain('alias:vendor-1');
    expect(payloadJson).not.toContain('Bad faith');
  });
});

// ── Handler registry ────────────────────────────────────────────────

// ── Codex review fold tests (2026-05-13) ───────────────────────────

describe('D-149 P2 — Codex P1 #1 fold: reception 90d expiry passes substrate clamp', () => {
  it('endpoint.expires_at = 60 days into the future builds without throw', () => {
    const sixtyDays = FIXED_NOW + 60 * 24 * 60 * 60 * 1000;
    const packet = buildReceptionPacket(
      'status_link_packet',
      statusLinkRaw(),
      endpointCtx('status_link_packet', { expires_at: sixtyDays }),
      buildOpts(),
    );
    expect(packet.expires_at).toBe(sixtyDays);
  });

  it('endpoint.expires_at = 90 days builds without throw', () => {
    const ninetyDays = FIXED_NOW + 90 * 24 * 60 * 60 * 1000;
    const packet = buildReceptionPacket(
      'status_link_packet',
      statusLinkRaw(),
      endpointCtx('status_link_packet', { expires_at: ninetyDays }),
      buildOpts(),
    );
    expect(packet.expires_at).toBe(ninetyDays);
  });

  it('endpoint.expires_at beyond 90 days still rejects (defense in depth)', () => {
    const oneHundredDays = FIXED_NOW + 100 * 24 * 60 * 60 * 1000;
    expect(() =>
      buildReceptionPacket(
        'status_link_packet',
        statusLinkRaw(),
        endpointCtx('status_link_packet', { expires_at: oneHundredDays }),
        buildOpts(),
      ),
    ).toThrow();
  });
});

describe('D-149 P2 — per-kind handler skeleton registry', () => {
  it('has a handler entry for every reception kind', () => {
    for (const kind of RECEPTION_PACKET_KINDS) {
      expect(typeof RECEPTION_KIND_HANDLERS[kind]).toBe('function');
    }
  });

  it('assertReceptionHandlerRegistryComplete passes', () => {
    expect(() => assertReceptionHandlerRegistryComplete()).not.toThrow();
  });

  it('each handler skeleton returns 503 not_implemented (P2 placeholder; P4+ wires per-kind renders)', async () => {
    class FakeRes {
      statusCode = 0;
      headers: Record<string, string> = {};
      body: string | null = null;
      setHeader(k: string, v: string): void {
        this.headers[k.toLowerCase()] = v;
      }
      end(body?: string): void {
        this.body = body ?? '';
      }
    }
    // D-149 P4 — reception_page_packet now renders the substrate
    // placeholder HTML (200 with text/html) instead of the P2 503
    // stub. The other five kinds keep the 503 stub until P5-P9 wire
    // their per-kind logic. Skip reception_page_packet in this
    // assertion; P4's `d-149-phase-4-reception-page-handler.test.ts`
    // covers the new behavior end-to-end.
    for (const kind of RECEPTION_PACKET_KINDS) {
      if (kind === 'reception_page_packet') continue;
      const handler = RECEPTION_KIND_HANDLERS[kind];
      const res = new FakeRes();
      const req = { url: '/reception/' + kind, method: 'GET', headers: {} } as never;
      await handler(req, res as never, endpointCtx(kind));
      expect(res.statusCode).toBe(503);
      const parsed = JSON.parse(res.body ?? 'null');
      expect(parsed).toEqual({ error: { code: 'not_implemented' } });
    }
  });

  it('non-reception_page kinds: 503 body contains no role-name / kind fingerprint', async () => {
    class FakeRes {
      statusCode = 0;
      headers: Record<string, string> = {};
      body: string | null = null;
      setHeader(k: string, v: string): void {
        this.headers[k.toLowerCase()] = v;
      }
      end(body?: string): void {
        this.body = body ?? '';
      }
    }
    // Spot-check a non-reception_page kind — P4 wires reception_page's
    // live render so its body intentionally carries the substrate-defined
    // copy. The fingerprint floor still applies to the 503-returning
    // P5-P9 stubs.
    const res = new FakeRes();
    const req = { url: '/reception/scheduling/abc', method: 'GET', headers: {} } as never;
    await RECEPTION_KIND_HANDLERS.scheduling_link_packet(
      req,
      res as never,
      endpointCtx('scheduling_link_packet'),
    );
    const body = res.body ?? '';
    expect(body).not.toContain('reception');
    expect(body).not.toContain('scheduling_link');
    expect(body).not.toContain('intake_form');
    expect(body).not.toContain('drop_link');
    expect(body).not.toContain('approval_link');
    expect(body).not.toContain('status_link');
    expect(body).not.toContain('recued');
  });
});
