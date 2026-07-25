/** D-164 P8 — backend contact has-email wiring + the mention-only fix.
 *
 *  Exercises `createPromptCacheGateDeps` end-to-end through the composed
 *  four-family matcher + probe + renderer (with a fake ContactStore):
 *    - the has-email family (registered FIRST) answers a presence question
 *      with "Yes, …" when the local warehouse has a real email;
 *    - the CRM-gated deterministic "no": an email-less contact renders
 *      "No, there's no email address on file for …" ONLY when the
 *      connection + enrichment stores prove no CRM contact source exists;
 *      any CRM coverage — or absent wiring (the legacy 2-arg call) — defers;
 *    - a `mention_only` contact's synthetic placeholder email is STRIPPED in
 *      `contactLookup`, so the has-email family defers it (or renders the
 *      gated "no") and the P5 attribute family never surfaces the placeholder;
 *    - P5 still owns "what is `<Name>`'s email?" (the has-email matcher only
 *      takes presence-inversion forms);
 *    - the P5 terminal-attribute fix: a yes/no PREDICATE ("is `<Name>`'s email
 *      valid?") matches NO family → pass through. */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_ATTRIBUTE_TEMPLATES,
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
} from '@recued/middleware-prompt-cache';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';

const NAME_SLOT = {
  kind: 'entity.name',
  value: 'Pat Lee',
  raw: 'Pat Lee',
  position: 18,
} as const;

const contactStore = (
  rows: ReadonlyArray<{ email: string; name?: string }>,
): ContactStore =>
  ({
    list: () => rows,
    // D-205 #3.5b — the gate reads the COMPLETE address set (anchor INCLUDED),
    // where it used to read the merged-away addresses (anchor EXCLUDED).
    addressSet: (email: string) => [email],
  }) as unknown as ContactStore;

const PAT_STORE = contactStore([{ email: 'pat@x.com', name: 'Pat Lee' }]);
/** A mention_only contact — carries the synthetic placeholder email PA8 emits
 *  (`mention-only-…@_recued.invalid`) for a contact with no real email yet. */
const MENTION_ONLY_STORE = contactStore([
  { email: 'mention-only-pat-lee@_recued.invalid', name: 'Pat Lee' },
]);

/** Fake connection store — `rows` are the `kind: 'api'` rows `list` surfaces;
 *  the CRM predicate resolves each row's vendor from config_json/subtype. */
const connectionStore = (
  rows: ReadonlyArray<{ name: string; subtype?: string; config_json?: string }>,
): ConnectionStoreSqlite =>
  ({
    list: () => rows.map((r) => ({ config_json: '{}', ...r })),
  }) as unknown as ConnectionStoreSqlite;

/** Fake enrichment store — `scopesWithRows` lists the platform-reference
 *  scopes whose contact mirror still holds at least one row. */
const enrichmentStore = (scopesWithRows: readonly string[] = []): EnrichmentStore =>
  ({
    listScopeMeta: (scope: string) =>
      scopesWithRows.includes(scope) ? [{ scope, target_id: 't', meta: {} }] : [],
  }) as unknown as EnrichmentStore;

/** No CRM anywhere — the deterministic "no" may fire. */
const NO_CRM = {
  connections: connectionStore([]),
  enrichments: enrichmentStore([]),
};

const deps = (
  store: ContactStore | undefined,
  crm?: { connections: ConnectionStoreSqlite; enrichments: EnrichmentStore },
) =>
  crm === undefined
    ? createPromptCacheGateDeps(() => store, () => undefined)
    : createPromptCacheGateDeps(
        () => store,
        () => undefined,
        () => crm.connections,
        () => crm.enrichments,
      );

/** Run the composed match → probe → render the gate runs, returning the final
 *  rendered text (`''` = the gate would pass through). */
const resolve = async (
  store: ContactStore | undefined,
  text: string,
  crm?: { connections: ConnectionStoreSqlite; enrichments: EnrichmentStore },
): Promise<{ template_hash: string | null; rendered: string }> => {
  const d = deps(store, crm);
  const template = await d.matchTemplate({ text, slots: [NAME_SLOT], locale: 'en' });
  if (template === null) return { template_hash: null, rendered: '' };
  const snap = await d.probeData({ template, slots: [NAME_SLOT] });
  if (snap === null) return { template_hash: template.template_hash, rendered: '' };
  // Mirror runGate: a probe may select a sibling body via the override seam.
  const effective = snap.render_template_override ?? template;
  const rendered = await d.renderTemplate(effective, snap);
  return { template_hash: effective.template_hash, rendered };
};

describe('D-164 P8 backend contact has-email + mention-only fix', () => {
  it('answers a presence question with the affirmative when a real email is present', async () => {
    const out = await resolve(PAT_STORE, 'do I have an email for Pat Lee?');
    expect(out.template_hash).toBe(CONTACT_HAS_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe("Yes, Pat Lee's email address is pat@x.com.");
  });

  it('answers the possessive presence form too (has-email wins over P5)', async () => {
    const out = await resolve(PAT_STORE, "do I have Pat Lee's email?");
    expect(out.template_hash).toBe(CONTACT_HAS_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe("Yes, Pat Lee's email address is pat@x.com.");
  });

  it('DEFERS a mention_only contact without CRM wiring — the synthetic placeholder is stripped, never surfaced', async () => {
    const out = await resolve(MENTION_ONLY_STORE, 'do I have an email for Pat Lee?');
    // The has-email matcher still fires (lexical), but the stripped email puts
    // the probe on its no-email branch, and with no CRM wiring (legacy 2-arg
    // deps) the coverage check fails CLOSED → null snapshot → pass through.
    expect(out.template_hash).toBe(CONTACT_HAS_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe('');
  });

  it('the mention-only strip also defers the P5 attribute family (no placeholder answer)', async () => {
    const out = await resolve(MENTION_ONLY_STORE, "what is Pat Lee's email?");
    expect(out.template_hash).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash);
    expect(out.rendered).toBe(''); // would have wrongly rendered the placeholder before the fix
  });

  it('leaves a what-is lookup to the P5 attribute family (not has-email)', async () => {
    const out = await resolve(PAT_STORE, "what is Pat Lee's email?");
    expect(out.template_hash).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash);
    expect(out.rendered).toBe("Pat Lee's email address is pat@x.com.");
  });

  it('passes through a yes/no PREDICATE about the email (matches no family)', async () => {
    const out = await resolve(PAT_STORE, "is Pat Lee's email valid?");
    expect(out.template_hash).toBeNull();
    expect(out.rendered).toBe('');
  });

  it('passes through a declarative statement (not a presence question)', async () => {
    const out = await resolve(PAT_STORE, 'I have an email for Pat Lee.');
    expect(out.template_hash).toBeNull();
    expect(out.rendered).toBe('');
  });
});

describe('D-164 P8 follow-up — CRM-gated deterministic "no"', () => {
  const ASK = 'do I have an email for Pat Lee?';

  it('renders the negative when no CRM contact source exists (the local store is the complete view)', async () => {
    const out = await resolve(MENTION_ONLY_STORE, ASK, NO_CRM);
    expect(out.template_hash).toBe(CONTACT_HAS_NO_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe("No, there's no email address on file for Pat Lee.");
  });

  it('still answers YES (never the negative) when the email is present, CRM or not', async () => {
    const out = await resolve(PAT_STORE, ASK, NO_CRM);
    expect(out.template_hash).toBe(CONTACT_HAS_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe("Yes, Pat Lee's email address is pat@x.com.");
  });

  it('defers when a CRM-contact connection is enrolled (vendor on subtype)', async () => {
    const out = await resolve(MENTION_ONLY_STORE, ASK, {
      connections: connectionStore([{ name: 'my-hubspot', subtype: 'hubspot' }]),
      enrichments: enrichmentStore([]),
    });
    expect(out.template_hash).toBe(CONTACT_HAS_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe('');
  });

  it('defers when a CRM-contact connection is enrolled (vendor on config_json)', async () => {
    const out = await resolve(MENTION_ONLY_STORE, ASK, {
      connections: connectionStore([
        { name: 'sales', config_json: '{"vendor":"salesforce"}' },
      ]),
      enrichments: enrichmentStore([]),
    });
    expect(out.rendered).toBe('');
  });

  it('defers when a platform contact MIRROR still holds rows (mirrors outlive the connection)', async () => {
    const out = await resolve(MENTION_ONLY_STORE, ASK, {
      connections: connectionStore([]),
      enrichments: enrichmentStore(['connection.api.hubspot.contact']),
    });
    expect(out.rendered).toBe('');
  });

  it('a NON-CRM api connection does not block the negative', async () => {
    const out = await resolve(MENTION_ONLY_STORE, ASK, {
      connections: connectionStore([{ name: 'weather', subtype: 'weatherapi' }]),
      enrichments: enrichmentStore([]),
    });
    expect(out.template_hash).toBe(CONTACT_HAS_NO_EMAIL_TEMPLATE.template_hash);
    expect(out.rendered).toBe("No, there's no email address on file for Pat Lee.");
  });

  it('an UNRESOLVED contact never renders the negative (absent name defers to the LLM)', async () => {
    const out = await resolve(contactStore([]), ASK, NO_CRM);
    expect(out.rendered).toBe('');
  });
});
