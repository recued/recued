import { describe, expect, it } from 'vitest';
import { crossCheckCatalogOpenApi } from '@recued/ingredients';

// D-192 CORE #8a — the publish-time OpenAPI op-prover reconciles a pack's WIRE
// op paths with the pinned document's path keys via a surface `path_alias`
// (proxy prefix / base-split / format suffix) + a per-op `openapi_path` escape
// for structural one-offs and explicit composite parameter expansions. Proving-
// only — the runtime keeps calling `path_template`. Deterministic + rigorous: a
// wrong alias/path/expansion still fails.

const SHA = 'a'.repeat(64);

const manifest = (
  op: {
    key: string;
    method: string;
    path_template: string;
    openapi_path?: string;
    openapi_path_param_expansions?: Record<string, string[]>;
  },
  pathAlias?: Record<string, unknown>,
): Record<string, unknown> => ({
  surfaces: {
    api: {
      openapi_source: {
        url: 'https://example.com/openapi.json',
        sha256: SHA,
        ...(pathAlias ? { path_alias: pathAlias } : {}),
      },
      executes: {
        [op.key]: {
          kind: 'rest',
          method: op.method,
          path_template: op.path_template,
          ...(op.openapi_path ? { openapi_path: op.openapi_path } : {}),
          ...(op.openapi_path_param_expansions
            ? { openapi_path_param_expansions: op.openapi_path_param_expansions }
            : {}),
        },
      },
    },
  },
});

const doc = (paths: Record<string, Record<string, unknown>>) => ({ openapi: '3.1.0', paths });

const errs = (r: { issues: Array<{ severity: string; code: string; message: string }> }) =>
  r.issues.filter((i) => i.severity === 'error');

describe('D-192 CORE #8a — OpenAPI prover path_alias + per-op openapi_path', () => {
  it('jira: wire_prefix strips the /ex/jira/{cloudId} 3LO proxy prefix so the op proves', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        { key: 'issue.search', method: 'get', path_template: '/ex/jira/{{cloud_id}}/rest/api/3/search/jql' },
        { wire_prefix: '/ex/jira/{cloud_id}' },
      ),
      doc({ '/rest/api/3/search/jql': { get: {} } }),
    );
    expect(r.valid).toBe(true);
    expect(errs(r)).toEqual([]);
  });

  it('zendesk: doc_base prepend + strip_suffix reconcile the /api/v2 base-split and .json', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        { key: 'ticket.list', method: 'get', path_template: '/tickets.json' },
        { doc_base: '/api/v2', strip_suffix: '.json' },
      ),
      doc({ '/api/v2/tickets': { get: {} } }),
    );
    expect(r.valid).toBe(true);
  });

  it('zendesk: a parameterized op (.json + base-split) proves', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        { key: 'ticket.read', method: 'get', path_template: '/tickets/{{ticket_id}}.json' },
        { doc_base: '/api/v2', strip_suffix: '.json' },
      ),
      doc({ '/api/v2/tickets/{ticket_id}': { get: {} } }),
    );
    expect(r.valid).toBe(true);
  });

  it('azure-devops: per-op openapi_path proves the interior optional {team} segment', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({
        key: 'work_item.query',
        method: 'post',
        path_template: '/{{organization}}/{{project}}/_apis/wit/wiql',
        openapi_path: '/{organization}/{project}/{team}/_apis/wit/wiql',
      }),
      doc({ '/{organization}/{project}/{team}/_apis/wit/wiql': { post: {} } }),
    );
    expect(r.valid).toBe(true);
  });

  it('per-op openapi_path OVERRIDES the surface alias, adding only documented segments', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        {
          key: 'work_item.query', method: 'post',
          path_template: '/{{organization}}/{{project}}/_apis/wit/wiql',
          openapi_path: '/{organization}/{project}/{team}/_apis/wit/wiql',
        },
        { doc_base: '/wrong' }, // the alias would map to /wrong/… — openapi_path wins
      ),
      doc({ '/{organization}/{project}/{team}/_apis/wit/wiql': { post: {} } }),
    );
    expect(r.valid).toBe(true);
  });

  it('RIGOR: openapi_path pointing at an UNRELATED doc path is rejected (subsequence guard)', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({ key: 'evil.read', method: 'get', path_template: '/evil/{{id}}', openapi_path: '/tickets/{id}' }),
      doc({ '/tickets/{id}': { get: {} } }), // a REAL doc path, but the wire path is not a subsequence of it
    );
    expect(r.valid).toBe(false);
    expect(errs(r).some((e) => e.message.includes('does not preserve the wire path'))).toBe(true);
  });

  it('RIGOR: openapi_path may not GRAFT a leading prefix the wire lacks (that is doc_base)', () => {
    // `/tickets/{}` IS an in-order subsequence of `/api/v2/tickets/{}` (a REAL
    // doc path), but its PREFIX differs — a bare subsequence would false-pass.
    // Anchoring the first segment rejects it: a wire that omits a base prefix
    // uses the surface `doc_base` alias (applied to every op), not a per-op
    // re-point that could claim any longer path sharing the wire's tail.
    const r = crossCheckCatalogOpenApi(
      manifest({ key: 't.read', method: 'get', path_template: '/tickets/{{id}}', openapi_path: '/api/v2/tickets/{id}' }),
      doc({ '/api/v2/tickets/{id}': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r).some((e) => e.message.includes('does not preserve the wire path'))).toBe(true);
  });

  it('RIGOR: openapi_path may not SWAP the terminal segment (a different resource)', () => {
    // `/a/{}` is a subsequence of `/a/{}/comments`, but the terminal segment
    // differs — `.../comments` is a different resource than `/a/{}`. Anchoring
    // the last segment rejects the trailing-graft re-point.
    const r = crossCheckCatalogOpenApi(
      manifest({ key: 'x.read', method: 'get', path_template: '/a/{{b}}', openapi_path: '/a/{b}/comments' }),
      doc({ '/a/{b}/comments': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r).some((e) => e.message.includes('does not preserve the wire path'))).toBe(true);
  });

  it('RIGOR: openapi_path may not APPEND a PARAM sub-resource past the terminal (M1)', () => {
    // The subtle terminal-swap the `{}`-normalized end-anchor missed: `/users/{id}`
    // is a subsequence of `/users/{id}/sessions/{sessionId}`, and BOTH terminals
    // normalize to `{}` — so a bare end-anchor false-passes an op re-pointed at a
    // DIFFERENT (deeper) resource. The name-preserving terminal check rejects it
    // (`{id}` ≠ `{sessionId}`).
    const r = crossCheckCatalogOpenApi(
      manifest({
        key: 'user.read', method: 'get',
        path_template: '/users/{{user_id}}',
        openapi_path: '/users/{user_id}/sessions/{session_id}',
      }),
      doc({ '/users/{user_id}/sessions/{session_id}': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r).some((e) => e.message.includes('does not preserve the wire path'))).toBe(true);
  });

  it('a GENUINE interior insert before a PARAM terminal still proves (not over-restricted)', () => {
    // `{team}` inserted in the interior; the terminal param NAME is preserved
    // (`{id}` == `{id}`), so this is a real interior expansion, not a re-point.
    const r = crossCheckCatalogOpenApi(
      manifest({
        key: 'item.read', method: 'get',
        path_template: '/{{project}}/{{id}}',
        openapi_path: '/{project}/{team}/{id}',
      }),
      doc({ '/{project}/{team}/{id}': { get: {} } }),
    );
    expect(r.valid).toBe(true);
    expect(errs(r)).toEqual([]);
  });

  it('circleci: an explicit composite project-slug expansion proves exact wire segments', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({
        key: 'pipeline.list',
        method: 'get',
        path_template: '/project/{{provider}}/{{organization}}/{{project}}/pipeline',
        openapi_path: '/project/{project-slug}/pipeline',
        openapi_path_param_expansions: {
          'project-slug': ['provider', 'organization', 'project'],
        },
      }),
      doc({ '/project/{project-slug}/pipeline': { get: {} } }),
    );
    expect(r.valid).toBe(true);
    expect(errs(r)).toEqual([]);
  });

  it('RIGOR: a composite parameter expansion cannot rename or reorder wire args', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({
        key: 'pipeline.list',
        method: 'get',
        path_template: '/project/{{provider}}/{{organization}}/{{project}}/pipeline',
        openapi_path: '/project/{project-slug}/pipeline',
        openapi_path_param_expansions: {
          'project-slug': ['provider', 'project', 'organization'],
        },
      }),
      doc({ '/project/{project-slug}/pipeline': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r)[0]?.message).toContain('do not expand exactly');
  });

  it('RIGOR: a composite parameter expansion cannot hide a literal path segment', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({
        key: 'pipeline.list',
        method: 'get',
        path_template: '/project/{{provider}}/evil/{{organization}}/{{project}}/pipeline',
        openapi_path: '/project/{project-slug}/pipeline',
        openapi_path_param_expansions: {
          'project-slug': ['provider', 'organization', 'project'],
        },
      }),
      doc({ '/project/{project-slug}/pipeline': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r)[0]?.message).toContain('do not expand exactly');
  });

  it('RIGOR: wire_prefix strips only at a segment boundary (/api/v1 ≠ /api/v1beta)', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({ key: 'x.list', method: 'get', path_template: '/api/v1beta/tasks' }, { wire_prefix: '/api/v1' }),
      doc({ '/beta/tasks': { get: {} } }), // would falsely match if the prefix stripped mid-segment
    );
    expect(r.valid).toBe(false);
  });

  it('RIGOR: a non-dotted strip_suffix is NOT applied by the prover (fail-closed)', () => {
    const r = crossCheckCatalogOpenApi(
      manifest({ key: 'u.list', method: 'get', path_template: '/users' }, { strip_suffix: 's' }),
      doc({ '/user': { get: {} } }), // would falsely match if the bare `s` were stripped
    );
    expect(r.valid).toBe(false);
  });

  it('RIGOR: a WRONG wire_prefix does not fuzzy-match — the op still fails', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        { key: 'issue.search', method: 'get', path_template: '/ex/jira/{{cloud_id}}/rest/api/3/search/jql' },
        { wire_prefix: '/wrong/prefix' },
      ),
      doc({ '/rest/api/3/search/jql': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r).some((e) => e.code === 'CATALOG_OPENAPI_MISMATCH')).toBe(true);
  });

  it('RIGOR: method mismatch still fails even when the alias reconciles the path', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        { key: 'ticket.list', method: 'delete', path_template: '/tickets.json' },
        { doc_base: '/api/v2', strip_suffix: '.json' },
      ),
      doc({ '/api/v2/tickets': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r).some((e) => e.code === 'CATALOG_OPENAPI_MISMATCH')).toBe(true);
  });

  it('names the reconciled doc path in the mismatch message', () => {
    const r = crossCheckCatalogOpenApi(
      manifest(
        { key: 'ticket.list', method: 'get', path_template: '/tickets.json' },
        { doc_base: '/api/v2', strip_suffix: '.json' },
      ),
      doc({ '/api/v2/users': { get: {} } }),
    );
    expect(r.valid).toBe(false);
    expect(errs(r)[0]?.message).toContain("proved as '/api/v2/tickets'");
  });

  it('BACKWARD-COMPAT: no path_alias → exact match unchanged (proves, and mismatches fail)', () => {
    const ok = crossCheckCatalogOpenApi(
      manifest({ key: 'x.read', method: 'get', path_template: '/x/{{id}}' }),
      doc({ '/x/{id}': { get: {} } }),
    );
    expect(ok.valid).toBe(true);
    const bad = crossCheckCatalogOpenApi(
      manifest({ key: 'x.read', method: 'get', path_template: '/nope' }),
      doc({ '/x/{id}': { get: {} } }),
    );
    expect(bad.valid).toBe(false);
  });
});
