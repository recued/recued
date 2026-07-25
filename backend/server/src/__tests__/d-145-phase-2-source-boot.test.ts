/** D-145 PA2 — Source primitive boot wire.
 *
 *  Coverage: `autoRegisterRecuedBuiltinSources` (idempotent on repeat
 *  boot) + `wireWorkEntitySourceBoot` (boot scan picks up existing
 *  HubSpot / Salesforce connections; upsert observer auto-registers
 *  on enrollment; delete observer unregisters; non-task-capable
 *  vendors are inert; cascade FK clears default-Source on connection
 *  delete). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTION_SOURCE_ID,
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_KINDS,
} from '@recued/contracts';

import { createConnectionStore } from '../storage/connection-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import {
  KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS,
  autoRegisterRecuedBuiltinSources,
  wireWorkEntitySourceBoot,
} from '../work-entity-source-boot.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;

const NOW = 1_700_000_000_000;

const upsertHubSpotConnection = (
  cs: ReturnType<typeof createConnectionStore>,
  name: string,
): void => {
  cs.upsert({
    kind: 'api',
    name,
    display_name: `HubSpot ${name}`,
    config_json: JSON.stringify({ vendor: 'hubspot' }),
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

const upsertSalesforceConnection = (
  cs: ReturnType<typeof createConnectionStore>,
  name: string,
): void => {
  cs.upsert({
    kind: 'api',
    name,
    display_name: `Salesforce ${name}`,
    config_json: JSON.stringify({ vendor: 'salesforce' }),
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd145-pa2-boot-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// autoRegisterRecuedBuiltinSources — § A.2 + spec PA2 acceptance
// ────────────────────────────────────────────────────────────────

describe('autoRegisterRecuedBuiltinSources', () => {
  it('registers one Source per WORK_ENTITY_KIND', () => {
    autoRegisterRecuedBuiltinSources(store, NOW);
    for (const kind of WORK_ENTITY_KINDS) {
      const reg = store.getSource(RECUED_BUILTIN_SOURCE_ID(kind));
      expect(reg).not.toBeNull();
      expect(reg!.top_tier_kind).toBe(kind);
      expect(reg!.source_kind).toBe('builtin');
      expect(reg!.write_capable).toBe(true);
      expect(reg!.mcp_exposed).toBe(false);
    }
  });

  it('uses the canonical "recued.<kind>" id format', () => {
    autoRegisterRecuedBuiltinSources(store, NOW);
    expect(store.getSource('recued.task')).not.toBeNull();
    expect(store.getSource('recued.note')).not.toBeNull();
    expect(store.getSource('recued.commitment')).not.toBeNull();
    expect(store.getSource('recued.project')).not.toBeNull();
  });

  it('idempotent on repeat boot — second call does not throw', () => {
    autoRegisterRecuedBuiltinSources(store, NOW);
    expect(() => autoRegisterRecuedBuiltinSources(store, NOW + 1000)).not.toThrow();
  });

  it('idempotent — preserves the original registered_at timestamp', () => {
    autoRegisterRecuedBuiltinSources(store, NOW);
    const first = store.getSource('recued.task')!;
    autoRegisterRecuedBuiltinSources(store, NOW + 9999);
    const second = store.getSource('recued.task')!;
    expect(second.registered_at).toBe(first.registered_at);
  });

  it('label is "Recued built-in" for every kind', () => {
    autoRegisterRecuedBuiltinSources(store, NOW);
    for (const kind of WORK_ENTITY_KINDS) {
      expect(store.getSource(RECUED_BUILTIN_SOURCE_ID(kind))!.source_label).toBe(
        'Recued built-in',
      );
    }
  });

  it('default `now` falls back to Date.now', () => {
    const before = Date.now();
    autoRegisterRecuedBuiltinSources(store);
    const reg = store.getSource('recued.task')!;
    expect(reg.registered_at).toBeGreaterThanOrEqual(before);
    expect(reg.registered_at).toBeLessThanOrEqual(Date.now());
  });
});

// ────────────────────────────────────────────────────────────────
// wireWorkEntitySourceBoot — boot scan + observer hooks
// ────────────────────────────────────────────────────────────────

describe('wireWorkEntitySourceBoot — boot scan', () => {
  it('registers a task Source for every existing HubSpot connection', () => {
    const cs = createConnectionStore(db);
    upsertHubSpotConnection(cs, 'acme');
    upsertHubSpotConnection(cs, 'beta');
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    const acme = store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'));
    const beta = store.getSource(CONNECTION_SOURCE_ID('hubspot', 'beta', 'task'));
    expect(acme).not.toBeNull();
    expect(beta).not.toBeNull();
    expect(acme!.source_kind).toBe('connection');
    expect(acme!.source_label).toContain('HubSpot tasks (acme)');
    // Codex P2 fold — capability-uncertain at PA2 (no scope-introspection
    // wire); PA3 probe flips when first dispatch confirms task scope.
    expect(acme!.write_capable).toBe(false);
    expect(acme!.mcp_exposed).toBe(false);
  });

  it('registers a task Source for every existing Salesforce connection', () => {
    const cs = createConnectionStore(db);
    upsertSalesforceConnection(cs, 'prod');
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    const reg = store.getSource(
      CONNECTION_SOURCE_ID('salesforce', 'prod', 'task'),
    );
    expect(reg).not.toBeNull();
    expect(reg!.source_label).toContain('Salesforce tasks (prod)');
  });

  it('skips non-task-capable vendors (custom api connection)', () => {
    const cs = createConnectionStore(db);
    cs.upsert({
      kind: 'api',
      name: 'custom',
      display_name: 'Custom',
      config_json: JSON.stringify({ vendor: 'custom-vendor' }),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    expect(
      store.listSources('task').filter((s) => s.source_kind === 'connection'),
    ).toHaveLength(0);
  });

  it('skips connections whose config_json is malformed', () => {
    const cs = createConnectionStore(db);
    cs.upsert({
      kind: 'api',
      name: 'bad',
      display_name: 'Bad',
      config_json: '{not-json}',
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(() =>
      wireWorkEntitySourceBoot({ connectionStore: cs, store }),
    ).not.toThrow();
    expect(
      store.listSources('task').filter((s) => s.source_kind === 'connection'),
    ).toHaveLength(0);
  });
});

describe('wireWorkEntitySourceBoot — upsert observer', () => {
  it('registers Source on new HubSpot enrollment', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'acme');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')),
    ).not.toBeNull();
  });

  it('registers Source on new Salesforce enrollment', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertSalesforceConnection(cs, 'prod');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('salesforce', 'prod', 'task')),
    ).not.toBeNull();
  });

  it('idempotent on token refresh — no duplicate raise', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'acme');
    expect(() => upsertHubSpotConnection(cs, 'acme')).not.toThrow();
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')),
    ).not.toBeNull();
  });

  it('non-task-capable vendor upsert leaves the registry empty', () => {
    const cs = createConnectionStore(db);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    cs.upsert({
      kind: 'api',
      name: 'custom',
      display_name: 'Custom',
      config_json: JSON.stringify({ vendor: 'custom-vendor' }),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(
      store.listSources('task').filter((s) => s.source_kind === 'connection'),
    ).toHaveLength(0);
  });

  it('non-api kind upsert is a no-op', () => {
    const cs = createConnectionStore(db);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    cs.upsert({
      kind: 'mcp',
      name: 'a-server',
      display_name: 'MCP server',
      config_json: JSON.stringify({}),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(
      store.listSources('task').filter((s) => s.source_kind === 'connection'),
    ).toHaveLength(0);
  });

  // Codex P2 fold — non-api kind upsert that shares a name with an
  // api-kind row must NOT reconcile away the api row's Source.
  it('non-api upsert does not unregister an existing api Source for the same name', () => {
    const cs = createConnectionStore(db);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'acme');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')),
    ).not.toBeNull();
    cs.upsert({
      kind: 'mcp',
      name: 'acme',
      display_name: 'MCP acme',
      config_json: JSON.stringify({}),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')),
    ).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Codex P2 fold — vendor-flip reconcile invariant
// ────────────────────────────────────────────────────────────────

describe('wireWorkEntitySourceBoot — vendor-flip reconcile (Codex P2 fold)', () => {
  it('hubspot → salesforce flip unregisters hubspot, registers salesforce', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'shared-name');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'shared-name', 'task')),
    ).not.toBeNull();
    // Same `(kind, name)` row, vendor flips via `config_json` rewrite.
    upsertSalesforceConnection(cs, 'shared-name');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'shared-name', 'task')),
    ).toBeNull();
    expect(
      store.getSource(CONNECTION_SOURCE_ID('salesforce', 'shared-name', 'task')),
    ).not.toBeNull();
  });

  it('hubspot → custom-vendor flip unregisters hubspot Source', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'morph');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'morph', 'task')),
    ).not.toBeNull();
    cs.upsert({
      kind: 'api',
      name: 'morph',
      display_name: 'Morphed',
      config_json: JSON.stringify({ vendor: 'custom-vendor' }),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'morph', 'task')),
    ).toBeNull();
    expect(
      store.listSources('task').filter((s) => s.source_kind === 'connection'),
    ).toHaveLength(0);
  });

  it('custom-vendor → hubspot flip registers hubspot Source', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    cs.upsert({
      kind: 'api',
      name: 'flipped',
      display_name: 'Custom',
      config_json: JSON.stringify({ vendor: 'custom-vendor' }),
      auth_ciphertext: 'CIPHER',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    expect(
      store.listSources('task').filter((s) => s.source_kind === 'connection'),
    ).toHaveLength(0);
    upsertHubSpotConnection(cs, 'flipped');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'flipped', 'task')),
    ).not.toBeNull();
  });

  it('hubspot → hubspot upsert (token refresh) leaves Source intact + idempotent', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'stable');
    const first = store.getSource(
      CONNECTION_SOURCE_ID('hubspot', 'stable', 'task'),
    )!;
    upsertHubSpotConnection(cs, 'stable');
    const second = store.getSource(
      CONNECTION_SOURCE_ID('hubspot', 'stable', 'task'),
    )!;
    expect(second.registered_at).toBe(first.registered_at);
  });

  it('vendor-flip clears any pinned default-Source via FK CASCADE', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'pinned');
    store.setDefaultSource(
      'task',
      CONNECTION_SOURCE_ID('hubspot', 'pinned', 'task'),
      NOW,
    );
    expect(store.getDefaultSource('task')).toBe(
      CONNECTION_SOURCE_ID('hubspot', 'pinned', 'task'),
    );
    upsertSalesforceConnection(cs, 'pinned');
    // FK CASCADE on Source unregister cleared the default; user must
    // re-pin to the new vendor's Source.
    expect(store.getDefaultSource('task')).toBeNull();
  });
});

describe('wireWorkEntitySourceBoot — delete observer', () => {
  it('unregisters the Source on connection delete', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'acme');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')),
    ).not.toBeNull();
    cs.delete('api', 'acme');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('hubspot', 'acme', 'task')),
    ).toBeNull();
  });

  it('unregisters the Source on Salesforce connection delete', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertSalesforceConnection(cs, 'prod');
    cs.delete('api', 'prod');
    expect(
      store.getSource(CONNECTION_SOURCE_ID('salesforce', 'prod', 'task')),
    ).toBeNull();
  });

  it('non-api delete is a no-op', () => {
    const cs = createConnectionStore(db);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    expect(() => cs.delete('mcp', 'never-registered')).not.toThrow();
  });

  it('clears any default-Source pointer at the deleted Source via FK CASCADE', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'acme');
    store.setDefaultSource(
      'task',
      CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
      NOW,
    );
    expect(store.getDefaultSource('task')).toBe(
      CONNECTION_SOURCE_ID('hubspot', 'acme', 'task'),
    );
    cs.delete('api', 'acme');
    expect(store.getDefaultSource('task')).toBeNull();
  });

  it('does not unregister the Recued built-in', () => {
    const cs = createConnectionStore(db);
    autoRegisterRecuedBuiltinSources(store, NOW);
    wireWorkEntitySourceBoot({ connectionStore: cs, store });
    upsertHubSpotConnection(cs, 'acme');
    cs.delete('api', 'acme');
    for (const kind of WORK_ENTITY_KINDS) {
      expect(store.getSource(RECUED_BUILTIN_SOURCE_ID(kind))).not.toBeNull();
    }
  });
});

describe('KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS (D-192 P2 — replaces TASK_CAPABLE_VENDORS)', () => {
  it('carries the first-party HubSpot (task + note) + Salesforce (task) + Microsoft To Do (task) declarations', () => {
    expect(Object.keys(KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS).sort())
      .toEqual(['hubspot', 'microsoft', 'salesforce']);
    // Every declaration preserves the exact PA2 CONNECTION_SOURCE_ID shape
    // (`<vendor>.${connection_id}.<kind>`) for its OWN kind.
    for (const [vendor, decls] of Object.entries(KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS)) {
      for (const decl of decls) {
        expect(decl.source_id_template).toBe(`${vendor}.\${connection_id}.${decl.kind}`);
      }
    }
    // HubSpot carries its task Source and (D-192 shape-settle pilot) a note
    // Source; Salesforce and Microsoft To Do carry only their task Source (the
    // To Do one being the read_write + etag-conditional-write axis).
    expect(KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS.hubspot!.map((d) => d.kind).sort())
      .toEqual(['note', 'task']);
    expect(KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS.salesforce!.map((d) => d.kind))
      .toEqual(['task']);
    expect(KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS.microsoft!.map((d) => d.kind))
      .toEqual(['task']);
  });
});
