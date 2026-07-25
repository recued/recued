/** D-192 P1b — the pack coverage gate (spec § Pack coverage gate).
 *
 *  Five real-vendor coverage declarations, each validated against a
 *  paths-only extract of its REAL pinned official OpenAPI document
 *  (URL + sha256 recorded in the fixture's `_extract` block; documents
 *  fetched + hashed 2026-07-01 — the full docs are megabytes, and
 *  `crossCheckCatalogOpenApi` reads only `paths`, so the extracts keep
 *  the suite hermetic without weakening the structural proof).
 *
 *  Dimension coverage (the spec's 8-item minimum):
 *   - simple personal task list + poll exemplar → Todoist
 *   - project/issue tracker with parent containers → GitHub (milestone
 *     relationship), Jira (project relationship)
 *   - CRM task/activity Source → HubSpot Tasks (associations-based
 *     contact/deal relationships = a recorded P2 finding, not declared)
 *   - read-only mode → Jira
 *   - native tombstones → HubSpot (archive semantics)
 *   - missing_means_deleted under a complete authoritative list → Asana
 *     (project-scoped full walk)
 *   - conditional-write / revision semantics → FINDING: no wave-1
 *     vendor documents conditional writes on task objects (all declare
 *     'none'); shape-covered by the P1 suite.
 *   - note/long-body preview fidelity → FINDING: Notion official
 *     OpenAPI unconfirmed (wave 1.5); long-body preview fidelity is
 *     exercised by the GitHub/Asana/HubSpot body previews meanwhile.
 *
 *  Google Tasks is BLOCKED for v1: Google publishes Discovery
 *  documents (`discovery#restDescription`, no `paths`), not OpenAPI —
 *  the eligibility fork is recorded in the P1b handover. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  crossCheckCatalogGoogleDiscovery,
  crossCheckCatalogOpenApi,
  validateIngredient,
} from '../validate.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'd-192-coverage');

const loadJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

interface CoverageVendor {
  slug: string;
  manifest: string;
  extract: string;
  dimensions: string[];
  /** Which pinned-document prover this vendor's declaration binds to
   *  (D-192 P2 — `google_discovery` admitted alongside `openapi`). */
  docKind?: 'openapi' | 'google_discovery';
}

const VENDORS: CoverageVendor[] = [
  {
    slug: 'github-issues-coverage',
    manifest: 'github-issues.json',
    extract: 'github.paths.json',
    dimensions: ['project/parent containers', 'lookup relationship', 'cursor', 'long-body preview'],
  },
  {
    slug: 'asana-tasks-coverage',
    manifest: 'asana-tasks.json',
    extract: 'asana.paths.json',
    dimensions: ['missing_means_deleted + complete_authoritative', 'boolean done', 'email lookup'],
  },
  {
    slug: 'jira-issues-coverage',
    manifest: 'jira-issues.json',
    extract: 'jira.paths.json',
    dimensions: ['read_only mode', 'filtered list scope', 'project relationship'],
  },
  {
    slug: 'hubspot-tasks-coverage',
    manifest: 'hubspot-tasks.json',
    extract: 'hubspot-tasks.paths.json',
    dimensions: ['CRM task/activity', 'native tombstones (archive)'],
  },
  {
    slug: 'todoist-tasks-coverage',
    manifest: 'todoist-tasks.json',
    extract: 'todoist.paths.json',
    dimensions: ['simple personal list', 'poll exemplar', 'complete op slot'],
  },
  {
    slug: 'google-tasks-coverage',
    manifest: 'google-tasks.json',
    extract: 'google-tasks.discovery.json',
    dimensions: ['google_discovery contract source', 'native tombstones (deleted flag)', 'cursor'],
    docKind: 'google_discovery',
  },
];

describe('D-192 P1b — coverage declarations validate against real pinned documents', () => {
  for (const vendor of VENDORS) {
    describe(`${vendor.slug} (${vendor.dimensions.join(' · ')})`, () => {
      const manifest = loadJson(vendor.manifest);
      const extract = loadJson(vendor.extract);

      it('actually declares a work-entity Source (guards against a silently-emptied fixture)', () => {
        const sources = manifest.work_entity_sources as Array<Record<string, unknown>>;
        expect(Array.isArray(sources)).toBe(true);
        expect(sources.length).toBeGreaterThan(0);
        // Every named op must be REST-bound in the fixture — otherwise the
        // cross-check assertions below prove nothing.
        const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
        const executes = surfaces.api!.executes as Record<string, Record<string, unknown>>;
        for (const decl of sources) {
          const ops = Object.values(decl.ops as Record<string, string | null>)
            .filter((v): v is string => typeof v === 'string' && v.length > 0);
          expect(ops.length).toBeGreaterThan(0);
          for (const opName of ops) expect(executes[opName]?.kind).toBe('rest');
        }
      });

      it('passes validateIngredient with zero errors', () => {
        const result = validateIngredient(manifest);
        const errors = result.issues.filter((i) => i.severity === 'error');
        expect(errors).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('proves every Source op against the pinned document extract', () => {
        const result = vendor.docKind === 'google_discovery'
          ? crossCheckCatalogGoogleDiscovery(manifest, extract)
          : crossCheckCatalogOpenApi(manifest, extract);
        expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('runs the cross-check through the single validation entry point', () => {
        const result = validateIngredient(manifest,
          vendor.docKind === 'google_discovery'
            ? { googleDiscoveryDocument: extract }
            : { openapiDocument: extract });
        expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(result.valid).toBe(true);
      });

      it('pin equality holds between contract_source and the surface pin', () => {
        const sources = manifest.work_entity_sources as Array<Record<string, unknown>>;
        const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
        const pinField = vendor.docKind === 'google_discovery'
          ? 'google_discovery_source' : 'openapi_source';
        const pin = surfaces.api![pinField] as Record<string, unknown>;
        for (const decl of sources) {
          const cs = decl.contract_source as Record<string, unknown>;
          expect(cs.url).toBe(pin.url);
          expect(cs.sha256).toBe(pin.sha256);
          const extractMeta = extract._extract as Record<string, unknown>;
          expect(extractMeta.url).toBe(pin.url);
          expect(extractMeta.sha256).toBe(pin.sha256);
        }
      });
    });
  }

  it('a Source op bound to a path ABSENT from the pinned document fails the cross-check', () => {
    const manifest = loadJson('github-issues.json');
    const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
    const executes = surfaces.api!.executes as Record<string, Record<string, unknown>>;
    executes['issue.list'] = { kind: 'rest', method: 'GET', path_template: '/repos/{owner}/{repo}/not-a-real-path' };
    const result = crossCheckCatalogOpenApi(manifest, loadJson('github.paths.json'));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'CATALOG_OPENAPI_MISMATCH')).toBe(true);
  });

  describe('google_discovery prover (D-192 P2 — the admitted second contract-source kind)', () => {
    it('a Source op with the wrong method fails as CATALOG_DISCOVERY_MISMATCH', () => {
      const manifest = loadJson('google-tasks.json');
      const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
      const executes = surfaces.api!.executes as Record<string, Record<string, unknown>>;
      executes['task.update'] = { kind: 'rest', method: 'PATCH', path_template: '/tasks/v1/lists/{tasklist}/tasks' };
      const result = crossCheckCatalogGoogleDiscovery(manifest, loadJson('google-tasks.discovery.json'));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) =>
        i.code === 'CATALOG_DISCOVERY_MISMATCH' && i.path === 'work_entity_sources[0].ops.update')).toBe(true);
    });

    it('a non-Discovery document fails as CATALOG_DISCOVERY_DOC_INVALID', () => {
      const result = crossCheckCatalogGoogleDiscovery(
        loadJson('google-tasks.json'),
        { paths: {} },
      );
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'CATALOG_DISCOVERY_DOC_INVALID')).toBe(true);
    });

    it('a non-REST-bound Source op fails as CATALOG_DISCOVERY_SOURCE_OP_UNPROVABLE', () => {
      const manifest = loadJson('google-tasks.json');
      const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
      const executes = surfaces.api!.executes as Record<string, Record<string, unknown>>;
      executes['task.read'] = { kind: 'graphql', operation_name: 'q' };
      const result = crossCheckCatalogGoogleDiscovery(manifest, loadJson('google-tasks.discovery.json'));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) =>
        i.code === 'CATALOG_DISCOVERY_SOURCE_OP_UNPROVABLE' && i.path === 'work_entity_sources[0].ops.read')).toBe(true);
    });

    it('kind separation: a google_discovery declaration is NOT held to the OpenAPI pin (and vice versa)', () => {
      // The Google manifest through the OPENAPI checker: its Source ops
      // are discovery-kind, so no CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE
      // fires even though the manifest has no openapi_source at all.
      const viaOpenApi = crossCheckCatalogOpenApi(loadJson('google-tasks.json'), { paths: {} });
      expect(viaOpenApi.issues.filter((i) => i.code === 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE')).toEqual([]);
      // And an openapi-kind manifest through the DISCOVERY checker is a
      // no-op (no discovery-kind declarations to prove).
      const viaDiscovery = crossCheckCatalogGoogleDiscovery(loadJson('github-issues.json'), { kind: 'nonsense' });
      expect(viaDiscovery.valid).toBe(true);
      expect(viaDiscovery.issues).toEqual([]);
    });

    it('mixed catalog: an OpenAPI pin does not hold Discovery-claimed ops to the OpenAPI doc (Codex F1)', () => {
      // Give the Google manifest an OpenAPI pin (as a mixed catalog
      // would carry for its ordinary ops) — the Discovery-claimed
      // Source ops must NOT fail the generic all-bindings OpenAPI loop
      // on paths that document never carried.
      const manifest = loadJson('google-tasks.json');
      const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
      surfaces.api!.openapi_source = { url: 'https://example.com/other-api.json', sha256: 'c'.repeat(64) };
      const result = crossCheckCatalogOpenApi(manifest, { paths: { '/unrelated': { get: {} } } });
      expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('a malformed google_discovery_source pin fails surface shape validation before any fetch (Codex F2)', () => {
      const manifest = loadJson('google-tasks.json');
      const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
      surfaces.api!.google_discovery_source = { url: 'http://not-https.example.com/doc', sha256: 'nope' };
      const result = validateIngredient(manifest);
      expect(result.valid).toBe(false);
      const codes = result.issues.filter((i) => i.severity === 'error').map((i) => `${i.code}@${i.path}`);
      expect(codes.some((c) => c.includes('CATALOG_SURFACE_INVALID@surfaces.api.google_discovery_source'))).toBe(true);
    });

    it('a declaration pinned to google_discovery fails shape validation without the surface pin', () => {
      const manifest = loadJson('google-tasks.json');
      const surfaces = manifest.surfaces as Record<string, Record<string, unknown>>;
      delete surfaces.api!.google_discovery_source;
      const result = validateIngredient(manifest);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.code === 'WORK_ENTITY_SOURCES_SURFACE_REQUIRED'
        || i.code === 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID')).toBe(true);
    });
  });
});
