import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import type { AvailabilityRawCalendarEvent, SchedulingLinkConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../../../backend/server/src/storage/reception-form-store.js';
import { createReceptionManageCredentialStore } from '../../../backend/server/src/storage/reception-manage-credential-store.js';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { deriveReceptionPepper, computeBearerHmac } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createInMemorySchedulingFormNonceStore } from '../../../backend/server/src/ports/reception/handlers/scheduling-link.js';
import type { ReceptionManageRescheduleRun } from '../../../backend/server/src/ports/reception/handlers/manage.js';

// The whole recovery flow uses native links and forms, under the shipped CSP.
// The dispatcher and SQLite stores are real; calendar reads and the held
// approval runner are controlled fixtures, with no provider writes.
test.use({ javaScriptEnabled: false });

const startManage = async () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const submissions = createReceptionFormSubmissionStore(db);
  const credentials = createReceptionManageCredentialStore(db);
  const cache = createReceptionRegistryCache(), limiter = createReceptionRateLimiter({ db });
  const nonce = createInMemorySchedulingFormNonceStore();
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x66));
  const wallTime = Date.now(), now = wallTime - wallTime % 1_800_000;
  const currentSlot = { start_at: now + 3_600_000, end_at: now + 5_400_000, duration_minutes: 30 };
  const config: SchedulingLinkConfig = {
    display_name: 'Fixture scheduling', instructions: 'Choose a new time for your booking.', duration_options_minutes: [30, 60],
    available_window_definition: { tz: 'UTC', explicit_windows: ([0, 1, 2, 3, 4, 5, 6] as const)
      .map(day_of_week => ({ day_of_week, start_minute: 0, end_minute: 1440 })) },
    required_visitor_fields: { name: 'required', email: 'required', topic: 'optional', phone: 'omit', notes: 'optional' },
    min_advance_notice_hours: 1, max_lead_time_days: 7, max_bookings_per_day: 0,
    on_booking: { create_calendar_event: true, create_commitment_entity: true },
  };
  registry.create({ endpoint_id: 'ep-manage-browser', kind: 'scheduling_link',
    packet_declaration: { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } },
    bearer_secret_hmac: computeBearerHmac('fixture-bearer', pepper), created_at: now, created_by_client_id: 'fixture',
    expires_at: now + 86_400_000, long_lived_acknowledged_at: null, metadata: { ...config },
  });
  registry.enable('ep-manage-browser', now);
  submissions.insert({ submission_id: 'request-browser', endpoint_id: 'ep-manage-browser', form_definition_id: null,
    submitted_at: now, source_ip_hash: null, visitor_email_encrypted: null, submission_blob_encrypted: 'AQID',
    schema_version: 1, processing_outcome: 'pending', slot: currentSlot,
  });
  submissions.markProcessed({ submission_id: 'request-browser', outcome: 'processed', resolved: { kind: 'booking', id: 'booking-browser' } });
  const issued = credentials.issue({ kind: 'scheduling_link', endpoint_id: 'ep-manage-browser', record_id: 'request-browser', purpose: 'manage', now });
  let events: ReadonlyArray<AvailabilityRawCalendarEvent> = [currentSlot];
  const calls: Array<Parameters<ReceptionManageRescheduleRun>[0]> = [];
  const handler = createReceptionPortHandler({ getStore: () => registry, getCache: () => cache,
    getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getReceptionManageCredentialStore: () => credentials, getIntakeFormSubmissionStore: () => submissions,
    getSchedulingCalendarReader: () => ({ list: () => events }), getSchedulingFormNonceStore: () => nonce,
    receptionManageCalendarSlug: 'local', getReceptionManageRescheduleRunner: () => ({ run: async input => {
      calls.push(input); return { kind: 'held' as const };
    } }),
  });
  const server = createServer((req, res) => { void handler(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No reschedule listener');
  return { credentials, issued, calls, now, currentSlot,
    url: `http://127.0.0.1:${address.port}/reception/manage/${issued.secret}`,
    setEvents: (value: ReadonlyArray<AvailabilityRawCalendarEvent>) => { events = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('a time taken after the picker loaded can be replaced on the same link and goes to approval once', async ({ page }) => {
  const manage = await startManage();
  try {
    await page.goto(manage.url);
    const originalNonce = await page.locator('[name="form_nonce"]').inputValue();
    const originalSlot = await page.getByLabel('Choose a time').inputValue();
    const [start_at, end_at] = originalSlot.split('|').map(Number);
    manage.setEvents([manage.currentSlot, { start_at: start_at!, end_at: end_at! }]);
    const conflict = page.waitForResponse(response => response.url() === manage.url && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Request new time', exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText('Availability has been refreshed');
    await expect(page.getByLabel('Choose a time').locator(`option[value="${originalSlot}"]`)).toHaveCount(0);
    expect(await page.locator('[name="form_nonce"]').inputValue()).not.toBe(originalNonce);
    expect(manage.credentials.peek(manage.issued.secret, manage.now, 'manage').status).toBe('ok');
    expect(manage.calls).toHaveLength(0);
    const replacement = await page.getByLabel('Choose a time').inputValue();
    expect(replacement).not.toBe(originalSlot);
    await page.getByRole('button', { name: 'Request new time', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Reschedule requested', exact: true })).toBeVisible();
    await expect(page.locator('body')).toContainText('sent for approval');
    const [newStart, newEnd] = replacement.split('|').map(Number);
    expect(manage.calls).toEqual([{ calendar_slug: 'local', booking_id: 'booking-browser', credential_id: manage.issued.credential_id,
      new_start_at: newStart, new_end_at: newEnd }]);
    expect(newEnd! - newStart!).toBe(30 * 60_000);
    expect((await page.goto(manage.url))?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Link unavailable', exact: true })).toBeVisible();
    expect(manage.calls).toHaveLength(1);
  } finally { await manage.close(); }
});

test('no remaining times can be checked again by keyboard when availability returns', async ({ page }) => {
  const manage = await startManage();
  try {
    await page.goto(manage.url);
    manage.setEvents([{ start_at: manage.now, end_at: manage.now + 8 * 86_400_000 }]);
    await page.getByRole('button', { name: 'Request new time', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Availability has been refreshed');
    await expect(page.locator('body')).toContainText('No available slots');
    await expect(page.getByRole('button', { name: 'Request new time', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Check availability again', exact: true })).toHaveAttribute('href', new URL(manage.url).pathname);
    const rejectedNonce = await page.locator('[name="form_nonce"]').inputValue();
    expect(manage.calls).toHaveLength(0);
    expect(manage.credentials.peek(manage.issued.secret, manage.now, 'manage').status).toBe('ok');
    manage.setEvents([manage.currentSlot]);
    // Native keyboard activation also covers access without a pointer. It
    // avoids Playwright's in-page click retry timer, which cannot run in
    // Chromium with scripts disabled when a CSS transition triggers a retry.
    await page.getByRole('link', { name: 'Check availability again', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Choose a time')).toBeVisible();
    expect(await page.locator('[name="form_nonce"]').inputValue()).not.toBe(rejectedNonce);
    expect(manage.credentials.peek(manage.issued.secret, manage.now, 'manage').status).toBe('ok');
    expect(manage.calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Request new time', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Reschedule requested', exact: true })).toBeVisible();
    expect(manage.calls).toHaveLength(1);
  } finally { await manage.close(); }
});
