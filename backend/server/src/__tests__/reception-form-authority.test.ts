import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IntakeFormConfig, SchedulingLinkConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../storage/reception-form-store.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createInMemorySchedulingFormNonceStore } from '../ports/reception/handlers/scheduling-link.js';
import { createInMemoryIntakeFormNonceStore } from '../ports/reception/handlers/intake-form.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../ports/reception/form-pii.js';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000 - 1_700_000_000_000 % (HOUR / 2);
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0x77));
const bookingConfig: SchedulingLinkConfig = {
  display_name: 'Fixture', instructions: 'Book a meeting.', duration_options_minutes: [30],
  available_window_definition: { tz: 'UTC', explicit_windows: ([0, 1, 2, 3, 4, 5, 6] as const)
    .map(day_of_week => ({ day_of_week, start_minute: 0, end_minute: 1440 })) },
  required_visitor_fields: { name: 'required', email: 'required', topic: 'optional', phone: 'omit', notes: 'optional' },
  min_advance_notice_hours: 1, max_lead_time_days: 30, max_bookings_per_day: 1,
  on_booking: { create_calendar_event: true, create_commitment_entity: true },
};
const intakeConfig: IntakeFormConfig = {
  display_name: 'Fixture', instructions: 'Send a message.', success_message: 'Received.', submit_button_label: 'Send',
  form_definition: { form_definition_id: 'fd-probe', fields: [{ name: 'message', type: 'text', label: 'Message', required: true }],
    user_only_field_names: [] },
  submission_processing_rule: { target_kind: 'task', fields_to_include_in_target: ['message'], fields_to_attach_as_metadata: [] },
  anti_spam: { honeypot_fields: [], rate_limit_per_ip: 1, require_proof_of_work: false, require_captcha: false },
  required_visitor_fields: { email: 'required' },
};

const fixture = (kind: 'booking' | 'intake', {
  expiry = NOW + 24 * HOUR, databasePath = ':memory:', trustForwardedFor = false,
}: { expiry?: number; databasePath?: string; trustForwardedFor?: boolean } = {}) => {
  const db = new Database(databasePath);
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db), submissions = createReceptionFormSubmissionStore(db);
  const cache = createReceptionRegistryCache(), limiter = createReceptionRateLimiter({ db });
  const bookingNonce = createInMemorySchedulingFormNonceStore(), intakeNonce = createInMemoryIntakeFormNonceStore();
  let now = NOW;
  const endpoint = 'ep-probe', registryKind = kind === 'booking' ? 'scheduling_link' : 'intake_form';
  registry.create({ endpoint_id: endpoint, kind: registryKind,
    packet_declaration: kind === 'booking'
      ? { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } }
      : { packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'fd-probe' } },
    bearer_secret_hmac: computeBearerHmac('fixture-bearer', PEPPER), created_at: NOW - HOUR,
    created_by_client_id: 'fixture', expires_at: expiry, long_lived_acknowledged_at: null,
    metadata: kind === 'booking' ? { ...bookingConfig } : { ...intakeConfig } });
  registry.enable(endpoint, now);
  const auditCalls: Array<Parameters<AuditLogStore['logActivity']>[0]> = [];
  const handler = createReceptionPortHandler({
    getStore: () => registry, getCache: () => cache, getRateLimiter: () => limiter,
    trustForwardedFor,
    getPepper: () => PEPPER, now: () => now, getIntakeFormSubmissionStore: () => submissions,
    getSchedulingFormNonceStore: () => bookingNonce, getIntakeFormNonceStore: () => intakeNonce,
    getSchedulingCalendarReader: () => ({ list: () => [] }),
    getIntakeFormSubmissionPiiKey: () => deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x4a)),
    auditLog: { logActivity: async input => { auditCalls.push(input); } } as AuditLogStore,
  });
  const start = (request: { tokenHeader?: 'authorization' | 'x-recued-endpoint-token';
    headers?: Record<string, string | undefined>; nonce?: string } = {}) => {
    const { tokenHeader } = request;
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5' });
    const req = new IncomingMessage(socket);
    req.method = 'POST';
    const path = kind === 'booking' ? `/reception/scheduling/${endpoint}/book` : `/reception/intake/${endpoint}`;
    req.url = path + (tokenHeader ? '' : '?t=fixture-bearer');
    Object.assign(req.headers, { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded',
      ...(tokenHeader ? { [tokenHeader]: tokenHeader === 'authorization' ? 'Bearer fixture-bearer' : 'fixture-bearer' } : {}),
      ...request.headers });
    const response = { statusCode: 200, headers: new Map<string, string | number | readonly string[]>(), body: '',
      setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name.toLowerCase(), value); },
      getHeader(name: string) { return this.headers.get(name.toLowerCase()); },
      write(body: string | Buffer) { this.body += String(body); },
      end(body?: string | Buffer) { if (body !== undefined) this.body += String(body); } };
    const nonce = request.nonce ?? (kind === 'booking' ? bookingNonce.issue(endpoint, now) : intakeNonce.issue(endpoint, now));
    const body = new URLSearchParams({ form_nonce: nonce, visitor_email: 'visitor@example.com',
      ...(kind === 'booking' ? { duration: '30', slot: [NOW + 2 * HOUR, NOW + 2.5 * HOUR, 30].join('|'),
        visitor_name: 'Visitor', visitor_topic: 'Hello' } : { message: 'Hello' }) }).toString();
    const pending = handler(req, response as unknown as ServerResponse);
    const send = () => { req.emit('data', Buffer.from(body)); req.emit('end'); return pending; };
    return { req, response, pending, send, nonce };
  };
  const rows = () => kind === 'booking' ? submissions.listPendingBookingsForEndpoint(endpoint) : submissions.listPendingForEndpoint(endpoint);
  const change = (what: 'revoke' | 'disable' | 'rotate' | 'expire') => {
    if (what === 'revoke') registry.revoke({ endpoint_id: endpoint, now, reason: 'Owner revoked' });
    if (what === 'disable') registry.disable(endpoint, now);
    if (what === 'rotate') registry.rotateToken({ endpoint_id: endpoint, now,
      new_bearer_secret_hmac: computeBearerHmac('new-bearer', PEPPER) });
    if (what === 'expire') now = expiry;
    // Deliberately leave the dispatcher's cached admission snapshot stale.
  };
  return { db, registry, submissions, cache, endpoint, rows, start, change, auditCalls, setNow: (value: number) => { now = value; } };
};

describe.each(['booking', 'intake'] as const)('%s submission live authority', kind => {
  it('holds the writer lock from live authorization through insertion, including against another connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reception-form-authority-'));
    const databasePath = join(dir, 'reception.sqlite');
    const f = fixture(kind, { databasePath });
    f.db.pragma('journal_mode = WAL');
    const peer = new Database(databasePath);
    peer.pragma('busy_timeout = 0');
    const peerRegistry = createPublicEndpointRegistryStore(peer);
    const insert = (id: string, authorize: () => boolean) => {
      const input = {
        submission_id: id, endpoint_id: f.endpoint, submitted_at: NOW, source_ip_hash: 'source',
        visitor_email_encrypted: 'sealed-email', submission_blob_encrypted: 'sealed-blob',
        schema_version: 1, processing_outcome: 'pending', now: NOW,
      };
      return kind === 'booking'
        ? f.submissions.insertIfAvailable({ ...input, form_definition_id: null,
            slot: { start_at: NOW + 2 * HOUR, end_at: NOW + 2.5 * HOUR, duration_minutes: 30 },
            max_bookings_per_day: 1, day_window_start_at: NOW - 24 * HOUR }, authorize)
        : f.submissions.insertIfSourceAvailable({ ...input, form_definition_id: 'fd-probe',
            max_submissions_per_window: 1, window_start_at: NOW - HOUR }, authorize);
    };
    const authorize = () => f.registry.verifyBearer({ endpoint_id: f.endpoint,
      submitted_secret: 'fixture-bearer', pepper: PEPPER, now: NOW }).kind === 'ok';
    try {
      expect(insert('denied', () => false)).toEqual({ conflict: 'not_authorized' });
      expect(f.rows()).toEqual([]);
      const accepted = insert('accepted', () => {
        expect(() => peerRegistry.revoke({ endpoint_id: f.endpoint, now: NOW, reason: 'Owner revoked' }))
          .toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
        return authorize();
      });
      expect(accepted).toHaveProperty('row.submission_id', 'accepted');
      peerRegistry.revoke({ endpoint_id: f.endpoint, now: NOW, reason: 'Owner revoked' });
      expect(insert('revoked', authorize)).toEqual({ conflict: 'not_authorized' });
      expect(f.rows().map(row => row.submission_id)).toEqual(['accepted']);
    } finally { peer.close(); f.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['revoke', 'disable', 'rotate'] as const)('refuses %s while the body waits, without persisting a submission', async change => {
    const f = fixture(kind);
    try {
      const request = f.start();
      await vi.waitFor(() => expect(request.req.listenerCount('data')).toBeGreaterThan(0));
      f.change(change); await request.send();
      expect(request.response.statusCode).toBe(410);
      expect(f.rows()).toEqual([]);
      expect(f.auditCalls).not.toContainEqual(expect.objectContaining({ action: 'form_submission.received' }));
    } finally { f.db.close(); }
  });

  it.each(['revoke', 'expire'] as const)('refuses %s during PII sealing, without persisting a submission', async change => {
    const f = fixture(kind, { expiry: NOW + 120_000 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let sealing = false;
    const encrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    const spy = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      sealing = true; await held; return encrypt(...args);
    });
    let pending: Promise<void> | undefined;
    try {
      const request = f.start(); pending = request.send();
      await vi.waitFor(() => expect(sealing).toBe(true));
      f.change(change); release(); await pending;
      expect(request.response.statusCode).toBe(410);
      expect(f.rows()).toEqual([]);
      expect(f.auditCalls).not.toContainEqual(expect.objectContaining({ action: 'form_submission.received' }));
    } finally {
      release();
      try { await pending; } finally { spy.mockRestore(); f.db.close(); }
    }
  });

  it('accepts a valid header-authenticated submission and keeps its configured limit', async () => {
    const f = fixture(kind);
    try {
      const tokenHeader = kind === 'booking' ? 'x-recued-endpoint-token' : 'authorization';
      const first = f.start({ tokenHeader }); await first.send();
      expect(first.response.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
      const second = f.start({ tokenHeader }); await second.send();
      expect(second.response.statusCode).toBe(429); expect(f.rows()).toHaveLength(1);
    } finally { f.db.close(); }
  });
});

it('uses a booking expiry extension made while the request body waits', async () => {
  const f = fixture('booking', { expiry: NOW + 120_000 });
  try {
    const request = f.start();
    await vi.waitFor(() => expect(request.req.listenerCount('data')).toBeGreaterThan(0));
    f.registry.extend({ endpoint_id: f.endpoint, new_expires_at: NOW + 600_000, now: NOW });
    f.cache.invalidate(f.endpoint); f.setNow(NOW + 180_000);
    await request.send();
    expect(request.response.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
  } finally { f.db.close(); }
});

describe.each(['booking', 'intake'] as const)('%s dispatcher proxy origin policy', kind => {
  it.each(['origin', 'referer'] as const)('rejects a downgraded %s behind a trusted HTTPS proxy without spending the nonce', async source => {
    const f = fixture(kind, { trustForwardedFor: true });
    try {
      const headers = { origin: undefined, [source]: 'http://localhost', 'x-forwarded-proto': 'https' };
      const denied = f.start({ headers }); await denied.send();
      expect(denied.response.statusCode).toBe(403);
      expect(f.rows()).toEqual([]); expect(f.auditCalls).toEqual([]);
      const accepted = f.start({ headers: { ...headers, [source]: 'https://localhost' }, nonce: denied.nonce });
      await accepted.send();
      expect(accepted.response.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
    } finally { f.db.close(); }
  });

  it('ignores a forged forwarded scheme on a direct listener', async () => {
    const f = fixture(kind);
    try {
      const request = f.start({ headers: { origin: 'http://localhost', 'x-forwarded-proto': 'https' } });
      await request.send();
      expect(request.response.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
    } finally { f.db.close(); }
  });

  it('permits a no-JS opaque origin only with a valid form nonce', async () => {
    const f = fixture(kind, { trustForwardedFor: true });
    const headers = { origin: 'null', 'x-forwarded-proto': 'https' };
    try {
      const denied = f.start({ headers, nonce: 'never-issued' }); await denied.send();
      expect(denied.response.statusCode).toBe(400); expect(f.rows()).toEqual([]);
      const accepted = f.start({ headers }); await accepted.send();
      expect(accepted.response.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
    } finally { f.db.close(); }
  });
});
