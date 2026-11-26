import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import type { AvailabilityRawCalendarEvent, SchedulingLinkConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../../../backend/server/src/storage/reception-form-store.js';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { deriveReceptionPepper, computeBearerHmac } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createInMemorySchedulingFormNonceStore } from '../../../backend/server/src/ports/reception/handlers/scheduling-link.js';
import { deriveFormSubmissionPiiKeyFromSubDek } from '../../../backend/server/src/ports/reception/form-pii.js';

test.use({ javaScriptEnabled: false });

const startScheduling = async () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const submissions = createReceptionFormSubmissionStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const nonce = createInMemorySchedulingFormNonceStore();
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x56));
  const piiKey = deriveFormSubmissionPiiKeyFromSubDek(new Uint8Array(32).fill(0x41));
  const endpointId = 'ep-public-scheduling';
  const bearer = 'fixture-scheduling-bearer';
  const now = Date.UTC(2026, 10, 24, 16);
  const day = 86_400_000;
  const config: SchedulingLinkConfig = {
    display_name: 'Northwind Studio',
    instructions: 'Choose a time to discuss your project.',
    duration_options_minutes: [30, 60],
    available_window_definition: {
      tz: 'America/Los_Angeles',
      explicit_windows: ([0, 1, 2, 3, 4, 5, 6] as const)
        .map(day_of_week => ({ day_of_week, start_minute: 8 * 60, end_minute: 18 * 60 })),
    },
    required_visitor_fields: { name: 'required', email: 'required', topic: 'optional', phone: 'optional', notes: 'optional' },
    min_advance_notice_hours: 2,
    max_lead_time_days: 7,
    max_bookings_per_day: 0,
    on_booking: { create_calendar_event: true, create_commitment_entity: true },
  };
  registry.create({ endpoint_id: endpointId, kind: 'scheduling_link',
    packet_declaration: { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } },
    bearer_secret_hmac: computeBearerHmac(bearer, pepper), created_at: now, created_by_client_id: 'fixture',
    expires_at: now + day, long_lived_acknowledged_at: null, metadata: { ...config },
  });
  registry.enable(endpointId, now);

  let events: ReadonlyArray<AvailabilityRawCalendarEvent> = [];
  const auditLog = { logActivity: async () => undefined } as unknown as AuditLogStore;
  const handler = createReceptionPortHandler({ getStore: () => registry, getCache: () => cache,
    getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getIntakeFormSubmissionStore: () => submissions, getIntakeFormSubmissionPiiKey: () => piiKey,
    getSchedulingCalendarReader: () => ({ list: () => events }), getSchedulingFormNonceStore: () => nonce,
    auditLog,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Booking listener did not start');
  return {
    url: `http://127.0.0.1:${address.port}/reception/scheduling/${endpointId}?t=${bearer}`,
    bookings: () => submissions.listPendingBookingsForEndpoint(endpointId),
    setBusy: (busy: boolean) => { events = busy ? [{ start_at: now, end_at: now + 8 * day }] : []; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('desktop booking keeps the slot beside the contact form and submits the chosen duration and time', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  const scheduling = await startScheduling();
  try {
    expect((await page.goto(scheduling.url))?.status()).toBe(200);
    const length = page.getByLabel('Slot length');
    const time = page.getByLabel('Choose a time');
    const name = page.getByLabel(/Your name/);
    const confirm = page.getByRole('button', { name: 'Confirm booking', exact: true });
    await expect(time).toHaveAccessibleDescription('Times shown in America/Los_Angeles');
    await expect(confirm).toBeInViewport();
    const timeBox = (await time.boundingBox())!;
    const nameBox = (await name.boundingBox())!;
    expect(timeBox.x + timeBox.width).toBeLessThan(nameBox.x);

    await expect(length).toHaveValue('30');
    await length.selectOption('60');
    await page.getByRole('button', { name: 'Update', exact: true }).press('Enter');
    await expect(page).toHaveURL(/&duration=60$/);
    await expect(length).toHaveValue('60');
    const [selected] = await time.selectOption({ index: 1 });
    const [start_at, end_at, duration_minutes] = selected!.split('|').map(Number);
    expect(duration_minutes).toBe(60);
    expect(end_at! - start_at!).toBe(60 * 60_000);

    await name.fill('Avery');
    await page.getByLabel(/Email/).fill('avery@example.test');
    await page.getByLabel('Topic', { exact: true }).fill('Studio visit');
    await page.getByLabel('Phone', { exact: true }).fill('555 0100');
    await page.getByLabel('Notes', { exact: true }).fill('Use the west entrance.');
    const booked = page.waitForResponse(response => response.request().method() === 'POST');
    await confirm.press('Enter');
    const response = await booked;
    expect(response.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Booking received', exact: true })).toBeVisible();
    const submitted = new URLSearchParams(response.request().postData()!);
    expect(submitted.get('duration')).toBe('60');
    expect(submitted.get('slot')).toBe(selected);
    expect(submitted.get('visitor_notes')).toBe('Use the west entrance.');
    expect(scheduling.bookings().map(row => row.slot)).toEqual([{ start_at, end_at, duration_minutes }]);
  } finally {
    await scheduling.close();
  }
});

test.describe('booking with a touch pointer', () => {
  test.use({ hasTouch: true, viewport: { width: 1440, height: 800 } });

  test('rechecks an empty calendar at the chosen duration and restores the stacked booking form', async ({ page }) => {
    const scheduling = await startScheduling();
    scheduling.setBusy(true);
    try {
      await page.goto(`${scheduling.url}&duration=60`);
      const confirm = page.getByRole('button', { name: 'Confirm booking', exact: true });
      await expect(page.getByText('No available slots', { exact: false })).toBeVisible();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByLabel(/Your name/)).toHaveCount(0);
      expect(scheduling.bookings()).toHaveLength(0);

      scheduling.setBusy(false);
      const recheck = page.waitForResponse(response => response.url() === `${scheduling.url}&duration=60`);
      await page.getByRole('link', { name: 'Check availability again', exact: true }).press('Enter');
      expect((await recheck).request().method()).toBe('GET');
      await expect(page.getByLabel('Slot length')).toHaveValue('60');
      const time = page.getByLabel('Choose a time');
      await expect(time).toHaveValue(/\|60$/);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 800 });
        const timeBox = (await time.boundingBox())!;
        const nameBox = (await page.getByLabel(/Your name/).boundingBox())!;
        expect(timeBox.y + timeBox.height).toBeLessThan(nameBox.y);
      }
      await expect(confirm).toBeEnabled();
      expect(scheduling.bookings()).toHaveLength(0);
    } finally {
      await scheduling.close();
    }
  });
});
