/** D-122 Phase 4 — bulk-install pack dialog rendering. */

import { describe, expect, it } from 'vitest';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type PackContentRef,
} from '@recued/contracts';
import {
  renderBulkPackDialog,
  type BulkPackDialogState,
} from '../install/bulk-pack-dialog.js';
import { e } from '../template.js';

const baseManifest: BulkPackManifest = {
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'personal-crm-foundation',
  publisher: 'recued-core',
  name: 'Personal CRM Foundation',
  description: 'Ten extraction recipes that turn your inbox into a CRM.',
  version: 1,
  recipes: [
    { slug: 'extract-contact-from-mail', version: 1 },
    { slug: 'classify-mail-thread', version: 1 },
  ],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:personal-crm'],
};

const baseState: BulkPackDialogState = {
  manifest: baseManifest,
  recipes: [
    {
      ref: { slug: 'extract-contact-from-mail', version: 1 },
      name: 'Extract contact from mail',
      description: 'Annotates contact rows from sender headers.',
    },
    {
      ref: { slug: 'classify-mail-thread', version: 1 },
      name: 'Classify mail thread',
    },
  ],
  pack_will: ['Annotate ~5,200 mail messages', 'Build contact graph from ~340 unique senders'],
  recipe_costs: [
    { slug: 'extract-contact-from-mail', name: 'Extract contact from mail', daily_fires: 50, daily_tokens: 25_000 },
    { slug: 'classify-mail-thread', name: 'Classify mail thread', daily_fires: 30, daily_tokens: 18_000 },
  ],
  free_pool_summary: 'Free pool covers comfortably',
  permissions: [
    { slug: BULK_PACK_INSTALL_PERMISSION, description: 'Install all recipes in this pack', required: true },
    { slug: 'read_memory', description: 'Read prior-run context', required: false },
  ],
  install_enabled: true,
};

const appContents: PackContentRef[] = [
  { type: 'ingredient', ingredient_id: 'recued-core/github', ingredient_version: 1 },
  { type: 'operation_group', ingredient_id: 'recued-core/github', group_id: 'recued-core/github.issues.read' },
  {
    type: 'channel_binding',
    channel_name: 'github-issues',
    capability: 'inline',
    bound_to_catalog: 'recued-core/github',
    conversation_policy: { mode: 'thread' },
  },
  { type: 'policy', policy_id: 'recued-core/github.default' },
];

describe('D-122 Phase 4 — renderBulkPackDialog', () => {
  it('renders the manifest header (name, publisher, recipe count, description)', () => {
    const html = renderBulkPackDialog(baseState);
    expect(html).toContain('Personal CRM Foundation');
    expect(html).toContain('recued-core');
    expect(html).toContain('2 recipes');
    expect(html).toContain('extraction recipes that turn your inbox');
  });

  it('renders the per-pack will-do list', () => {
    const html = renderBulkPackDialog(baseState);
    expect(html).toContain('Annotate ~5,200 mail messages');
    expect(html).toContain('Build contact graph from ~340 unique senders');
  });

  it('renders one cost line per recipe with daily fires + tokens', () => {
    const html = renderBulkPackDialog(baseState);
    expect(html).toContain('Extract contact from mail');
    expect(html).toContain('50 fires/day');
    expect(html).toContain('25,000 tokens/day');
    expect(html).toContain('Classify mail thread');
    expect(html).toContain('30 fires/day');
  });

  it('renders the BYOK $/day informational line when provided', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      byok_dollars_per_day: 0.42,
    });
    expect(html).toContain('bring your own API key');
    expect(html).toContain('$0.42');
  });

  it('omits the BYOK line when not provided', () => {
    const html = renderBulkPackDialog(baseState);
    expect(html).not.toContain('bring your own API key');
  });

  it('renders failed recipes with a struck-through marker + reason', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      recipes: [
        { ref: { slug: 'good', version: 1 }, name: 'Good recipe' },
        {
          ref: { slug: 'gone', version: 1 },
          name: 'Removed recipe',
          failure: 'not_found',
          failure_message: 'No longer in marketplace',
        },
      ],
    });
    expect(html).toContain('bulk-pack-recipe--failed');
    expect(html).toContain('No longer in marketplace');
  });

  it('renders the pack-install permission with a "required" tag', () => {
    const html = renderBulkPackDialog(baseState);
    expect(html).toContain(BULK_PACK_INSTALL_PERMISSION);
    expect(html).toContain('required');
    expect(html).toContain('read_memory');
  });

  it('renders app capabilities with one row per content kind and a meta count', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      app_contents: appContents,
    });
    const capabilityRows = html.match(/<li class="bulk-pack-capability" data-kind=/g) ?? [];
    const meta = html.match(/<p class="bulk-pack-meta">([\s\S]*?)<\/p>/)?.[1] ?? '';

    expect(html).toContain('App capabilities');
    expect(capabilityRows).toHaveLength(4);
    expect(html).toContain('data-kind="ingredient"');
    expect(html).toContain('data-kind="operation_group"');
    expect(html).toContain('data-kind="channel_binding"');
    expect(html).toContain('data-kind="policy"');
    expect(meta).toContain('4 capabilities');
  });

  it('escapes HTML in app capability labels', () => {
    const channelName = '<img src=x onerror=alert(1)>';
    const policyId = '<script>alert(1)</script>';
    const html = renderBulkPackDialog({
      ...baseState,
      app_contents: [
        {
          type: 'channel_binding',
          channel_name: channelName,
          capability: 'inline',
          bound_to_catalog: 'recued-core/slack',
          conversation_policy: {},
        },
        { type: 'policy', policy_id: policyId },
      ],
    });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain(e(channelName));
    expect(html).toContain(e(policyId));
  });

  it('omits app capabilities and capability count when app_contents is absent or empty', () => {
    const omitted = renderBulkPackDialog(baseState);
    const empty = renderBulkPackDialog({ ...baseState, app_contents: [] });

    expect(omitted).not.toContain('App capabilities');
    expect(omitted).not.toContain('capabilities');
    expect(empty).not.toContain('App capabilities');
    expect(empty).not.toContain('capabilities');
  });

  it('disables the install button when install_enabled is false', () => {
    const html = renderBulkPackDialog({ ...baseState, install_enabled: false });
    const installBtn = html.match(/data-action="install-pack"[^>]*>/)?.[0] ?? '';
    expect(installBtn).toContain('disabled');
  });

  it('always renders the cancel button (never disabled)', () => {
    const html = renderBulkPackDialog({ ...baseState, install_enabled: false });
    expect(html).toContain('data-action="cancel-pack"');
  });

  it('renders the blocking-message banner when set', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      install_enabled: false,
      blocking_message: 'Pack manifest is older than this runtime supports — update Recued',
    });
    expect(html).toContain('Pack manifest is older');
    expect(html).toContain('role="alert"');
  });

  it('escapes HTML in the manifest description (XSS defense)', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      manifest: { ...baseManifest, description: '<script>alert(1)</script>' },
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles single-recipe count grammar correctly', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      manifest: {
        ...baseManifest,
        recipes: [{ slug: 'one', version: 1 }],
      },
      recipes: [{ ref: { slug: 'one', version: 1 }, name: 'Just one' }],
    });
    expect(html).toContain('1 recipe ');
    // No extra "s" — this was a single recipe.
    expect(html).not.toContain('1 recipes');
  });

  it('discloses required connections pre-install (UX flow-10) and suppresses when none', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      required_connections: [
        { kind: 'api', name: 'hubspot' },
        { kind: null, name: 'acme' },
      ],
    });
    expect(html).toContain('Connections needed');
    expect(html).toContain('hubspot (api)');
    expect(html).toContain('data-name="acme"');
    // kind-null entry renders the bare name (no parenthetical kind).
    expect(html).toContain('>acme</li>');

    // Omitted / empty → the section is suppressed.
    expect(renderBulkPackDialog(baseState)).not.toContain('Connections needed');
    expect(
      renderBulkPackDialog({ ...baseState, required_connections: [] }),
    ).not.toContain('Connections needed');
  });

  it('discloses required file slugs pre-install', () => {
    const html = renderBulkPackDialog({
      ...baseState,
      required_file_slugs: [
        {
          slug: null,
          variable: 'result_file_slug',
          label: 'Registered file slug of the result drop directory',
        },
      ],
    });

    expect(html).toContain('File access needed');
    expect(html).toContain('registered file collection');
    expect(html).toContain('Connections &rarr; Files');
    expect(html).toContain('Registered file slug of the result drop directory');
  });

  it('escapes HTML in required file slug labels', () => {
    const label = '<img src=x>';
    const html = renderBulkPackDialog({
      ...baseState,
      required_file_slugs: [{ slug: null, variable: 'result_file_slug', label }],
    });

    expect(html).not.toContain(label);
    expect(html).not.toContain('<img');
    expect(html).toContain(e(label));
  });

  it('suppresses required file slug disclosure when omitted or empty', () => {
    expect(renderBulkPackDialog(baseState)).not.toContain('File access needed');
    expect(
      renderBulkPackDialog({ ...baseState, required_file_slugs: [] }),
    ).not.toContain('File access needed');
  });
});
