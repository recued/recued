/** D-261 follow-on — the op identifier already contains the English. */
import { describe, expect, it } from 'vitest';
import { describeCatalogOperation } from '../operation-phrase.js';

const phrase = (operation_key: string, catalog_slug?: string): string =>
  describeCatalogOperation({ operation_key, operation_id: `pub/${catalog_slug ?? 'cat'}.${operation_key}`,
    ...(catalog_slug !== undefined ? { catalog_slug } : {}) });

describe('describeCatalogOperation', () => {
  it('composes verb + vendor + entity from the identifier alone', () => {
    expect(phrase('opportunity.delete', 'salesforce-catalog')).toBe('Delete opportunity · Salesforce');
    expect(phrase('deal.create', 'hubspot-catalog')).toBe('Create deal · Hubspot');
  });

  it('reads a snake_case action as the English phrase it already is', () => {
    expect(phrase('resources.get_all_properties_for_a_resource', 'acme-catalog'))
      .toBe('Get all properties for a resource · Acme');
  });

  /** `webhooks.delete_webhook` must not become "Delete webhook webhooks". */
  it('drops the entity when the action already names its object', () => {
    expect(phrase('webhooks.delete_webhook', 'stripe-catalog')).toBe('Delete webhook · Stripe');
    expect(phrase('webhook.create_webhook', 'stripe-catalog')).toBe('Create webhook · Stripe');
  });

  it('keeps a multi-word vendor readable and drops the packaging suffix', () => {
    expect(phrase('agreement.send', 'adobe-sign-agreement-workflows'))
      .toBe('Send agreement · Adobe Sign Agreement Workflows');
  });

  /** ⛔ THE REFUSALS. Composing a non-verb would produce "Version a Salesforce
   *  opportunity" or "Current a…" — worse than the id it replaced. Falling back
   *  costs nothing: the id is exactly what these asks print today. */
  it('falls back to the exact id for a noun-led action', () => {
    expect(phrase('cluster.indices', 'elastic-catalog')).toBe('pub/elastic-catalog.cluster.indices');
    expect(phrase('build.version', 'ci-catalog')).toBe('pub/ci-catalog.build.version');
  });

  it('falls back for a single-token blob and for 3+ segments', () => {
    expect(phrase('post_hiring_applications_search', 'hibob-catalog'))
      .toBe('pub/hibob-catalog.post_hiring_applications_search');
    expect(phrase('a.b.c', 'x-catalog')).toBe('pub/x-catalog.a.b.c');
  });

  it('composes without a catalog slug when none is known', () => {
    expect(describeCatalogOperation({ operation_key: 'invoice.send', operation_id: 'pub/c.invoice.send' }))
      .toBe('Send invoice');
  });
});
