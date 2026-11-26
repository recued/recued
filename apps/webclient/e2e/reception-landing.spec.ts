import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import type { DropLinkConfig, IntakeFormConfig, ReceptionPageConfig, SchedulingLinkConfig } from '@recued/contracts';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createInMemoryDropLinkNonceStore } from '../../../backend/server/src/ports/reception/handlers/drop-link.js';
import { createInMemoryIntakeFormNonceStore } from '../../../backend/server/src/ports/reception/handlers/intake-form.js';
import { createInMemorySchedulingFormNonceStore } from '../../../backend/server/src/ports/reception/handlers/scheduling-link.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { computeBearerHmac, deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { createReceptionFormSubmissionStore } from '../../../backend/server/src/storage/reception-form-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 620 } });

const studio = 'Northwind Studio';
const targets = [
  {
    id: 'fixture-booking', kind: 'scheduling_link', path: 'scheduling', action: 'Schedule a meeting',
    heading: `Schedule with ${studio}`,
    packet: { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } },
    config: {
      display_name: studio, duration_options_minutes: [30],
      available_window_definition: { tz: 'UTC', explicit_windows: [{ day_of_week: 2, start_minute: 480, end_minute: 1080 }] },
      required_visitor_fields: { name: 'required', email: 'required', topic: 'optional', phone: 'omit', notes: 'omit' },
      min_advance_notice_hours: 1, max_lead_time_days: 7, max_bookings_per_day: 0,
      on_booking: { create_calendar_event: true, create_commitment_entity: true },
    } satisfies SchedulingLinkConfig,
  },
  {
    id: 'fixture-intake', kind: 'intake_form', path: 'intake', action: 'Send a message',
    heading: `Send ${studio} a message`,
    packet: { packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'fixture-message' } },
    config: {
      display_name: studio,
      form_definition: { form_definition_id: 'fixture-message', fields: [{ name: 'message', label: 'Message', type: 'textarea', required: true }] },
      submission_processing_rule: { target_kind: 'task', fields_to_include_in_target: ['message'], fields_to_attach_as_metadata: [] },
      anti_spam: { honeypot_fields: [], rate_limit_per_ip: 5, require_proof_of_work: false, require_captcha: false },
      required_visitor_fields: { email: 'optional' },
    } satisfies IntakeFormConfig,
  },
  {
    id: 'fixture-upload', kind: 'drop_link', path: 'drop', action: 'Drop a file',
    heading: `Send a file to ${studio}`,
    packet: { packet_kind: 'drop_link_packet', source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'fixture-upload' } },
    config: {
      display_name: studio, link_kind: 'repeated', size_cap_bytes: 1024, allowed_mime_types: ['application/pdf'],
      expiry_days: 7, max_uploads_per_endpoint_per_day: 5,
      required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
      on_upload: { create_data_file_entity: true, auto_attach_to_contact: false },
    } satisfies DropLinkConfig,
  },
] as const;

const startLanding = async () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const submissions = createReceptionFormSubmissionStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x61));
  const schedulingNonce = createInMemorySchedulingFormNonceStore();
  const intakeNonce = createInMemoryIntakeFormNonceStore();
  const uploadNonce = createInMemoryDropLinkNonceStore();
  const now = Date.UTC(2026, 10, 24, 16);
  const token = (id: string) => `test-bearer-${id}`;
  for (const target of targets) {
    registry.create({
      endpoint_id: target.id, kind: target.kind, packet_declaration: target.packet,
      bearer_secret_hmac: computeBearerHmac(token(target.id), pepper), created_at: now, created_by_client_id: 'fixture',
      expires_at: now + 86_400_000, long_lived_acknowledged_at: null, metadata: { ...target.config },
    });
    registry.enable(target.id, now);
  }

  const handler = createReceptionPortHandler({
    getStore: () => registry, getCache: () => cache, getRateLimiter: () => limiter, getPepper: () => pepper, now: () => now,
    getIntakeFormSubmissionStore: () => submissions, getSchedulingCalendarReader: () => ({ list: () => [] }),
    getSchedulingFormNonceStore: () => schedulingNonce, getIntakeFormNonceStore: () => intakeNonce, getDropLinkNonceStore: () => uploadNonce,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Landing page listener did not start');
  const url = `http://127.0.0.1:${address.port}/reception`;
  const shareUrl = (target: typeof targets[number]) => `${url}/${target.path}/${target.id}?t=${token(target.id)}`;
  const [booking, intake, upload] = targets;
  const config: ReceptionPageConfig = {
    display_overrides: {
      display_name: studio, tagline: 'Design and project coordination for retail, workplace, and community spaces.',
      response_time_estimate: 'Usually replies within two business days.', tz_label: 'America/Los_Angeles',
      preferred_contact_methods: ['email', 'phone', 'slack'],
    },
    sections_enabled: { contact_card: true, contact_methods: true, availability_cta: true, intake_cta: true, drop_cta: true, custom_links: true, link_buttons: true },
    linked_endpoints: {
      scheduling_link_endpoint_id: booking.id, scheduling_link_share_url: shareUrl(booking),
      intake_form_endpoint_id: intake.id, intake_form_share_url: shareUrl(intake),
      drop_link_endpoint_id: upload.id, drop_link_share_url: shareUrl(upload),
    },
    custom_links: [{ label: 'Project portfolio', url: 'https://example.test/projects' }],
    link_buttons: [{ label: 'Project brief template', url: 'https://example.test/brief', description: 'Gather the details before you send your brief.' }],
  };
  registry.upsertReceptionPageSingleton({ config, now, actor_instance_id: 'fixture' });
  return {
    url, shareUrl,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('Quick actions open all three configured public forms by keyboard', async ({ page }) => {
  const landing = await startLanding();
  try {
    expect((await page.goto(landing.url))?.status()).toBe(200);
    const actions = page.getByRole('navigation', { name: 'Quick actions' });
    await expect(actions.getByRole('link')).toHaveText(targets.map(target => target.action));
    await expect(page.getByRole('region', { name: 'Other links' }).getByRole('link', { name: 'Project portfolio' }))
      .toHaveAttribute('href', 'https://example.test/projects');
    await expect(page.getByRole('region', { name: 'Links' }).getByRole('link', { name: 'Project brief template' }))
      .toHaveAttribute('href', 'https://example.test/brief');

    for (const target of targets) {
      const href = landing.shareUrl(target);
      const link = actions.getByRole('link', { name: target.action, exact: true });
      await expect(link).toHaveAttribute('href', href);
      const opened = page.waitForResponse(response => response.url() === href && response.request().isNavigationRequest());
      await link.press('Enter');
      expect((await opened).status(), target.action).toBe(200);
      await expect(page).toHaveURL(href);
      await expect(page.getByRole('heading', { name: target.heading, exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(landing.url);
    }
  } finally {
    await landing.close();
  }
});
