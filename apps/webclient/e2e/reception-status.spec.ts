import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN, type StatusLinkConfig } from '@recued/contracts';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { computeBearerHmac, deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionStatusProjectionStore } from '../../../backend/server/src/storage/reception-status-projection-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 620 } });

const refreshSeconds = STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN;
const initialAgenda = 'Review the finish schedule and agree the date for the follow-up walkthrough.';
const updatedAgenda = 'Review the updated lighting drawings and confirm the handover date.';
const withheldLocation = 'Internal studio room 17';
const privateNote = 'Internal staffing note';

const startStatus = async () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const projections = createReceptionStatusProjectionStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x53));
  const now = Date.UTC(2026, 10, 24, 16);
  const endpointId = 'ep-public-workshop';
  const eventId = 'event-workshop';
  const bearer = 'fixture-status-bearer';
  const publicFields = ['title', 'date', 'tz_label', 'agenda_summary', 'visible_attendees'];
  const config: StatusLinkConfig = {
    display_name: 'Northwind Studio',
    caption: 'Shared workshop information',
    projection_kind: 'event_plan',
    source_ref: { kind: 'data.event', event_id: eventId },
    fields_visible_override: publicFields,
    refresh_policy: { auto_refresh_enabled: true, refresh_interval_seconds: refreshSeconds },
    comments_enabled: false, shows_update_history: true, expiry_days: 1,
  };
  registry.create({
    endpoint_id: endpointId, kind: 'status_link',
    packet_declaration: { packet_kind: 'status_link_packet', source_query_ref: config.source_ref },
    bearer_secret_hmac: computeBearerHmac(bearer, pepper), created_at: now, created_by_client_id: 'fixture',
    expires_at: now + 86_400_000, long_lived_acknowledged_at: null, metadata: { ...config },
  });
  registry.enable(endpointId, now);
  projections.create({
    projection_id: endpointId, endpoint_id: endpointId, projection_kind: config.projection_kind,
    source_entity_kind: config.source_ref.kind, source_entity_id: eventId,
    fields_visible_override: publicFields, refresh_policy: config.refresh_policy,
    comments_enabled: config.comments_enabled, shows_update_history: config.shows_update_history,
  });

  let row = {
    title: 'Studio handover workshop', date: 'December 4, 2026, 10:30 AM', tz_label: 'America/Los_Angeles',
    location_label: withheldLocation, agenda_summary: initialAgenda, visible_attendees: ['Morgan Avery', 'Dana Velez'],
    private_notes: privateNote,
  };
  let lastUpdatedAt = now - 60 * 60_000;
  const handler = createReceptionPortHandler({
    getStore: () => registry, getCache: () => cache, getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getStatusProjectionStore: () => projections,
    getStatusEntitySourceReader: () => ({ read: ({ source_entity_id }) => source_entity_id === eventId
      ? { row, last_updated_at: lastUpdatedAt }
      : null }),
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Status listener did not start');
  return {
    url: `http://127.0.0.1:${address.port}/reception/status/${endpointId}?t=${bearer}`,
    update: () => {
      row = { ...row, agenda_summary: updatedAgenda, visible_attendees: [...row.visible_attendees, 'Quinn Foster'] };
      lastUpdatedAt = now;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('native status refresh updates the public agenda without widening the field projection', async ({ page }) => {
  const status = await startStatus();
  try {
    const initial = await page.goto(status.url);
    expect(initial?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Studio handover workshop' })).toBeVisible();
    await expect(page.getByText(initialAgenda, { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText(['Morgan A.', 'Dana V.']);
    expect(await initial!.text()).not.toContain(withheldLocation);

    const refreshed = page.waitForResponse(response => response.url() === status.url
      && response.request().method() === 'GET' && response.request().isNavigationRequest(),
    { timeout: (refreshSeconds + 8) * 1000 });
    status.update();
    const response = await refreshed;
    expect(response.status()).toBe(200);
    await expect(page).toHaveURL(status.url);
    await expect(page.getByText(updatedAgenda, { exact: true })).toBeVisible();
    await expect(page.getByText(initialAgenda, { exact: true })).toHaveCount(0);
    await expect(page.getByText('December 4, 2026, 10:30 AM', { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveText(['Morgan A.', 'Dana V.', 'Quinn F.']);
    const html = await response.text();
    expect(html).not.toContain(withheldLocation);
    expect(html).not.toContain(privateNote);
    expect(html).not.toContain('Quinn Foster');
  } finally {
    await status.close();
  }
});
