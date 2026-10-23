import { describe, expect, it } from 'vitest';
import type { ServerExecuteResponse } from '@recued/contracts';
import {
  createResultActionRegistry,
  renderRecipeResultPanel,
  type RecipesResultPanelSnapshot,
} from '../recipes/recipe-result-panel.js';
import { parseLogsRunAddress, parseShellRoute } from '../shell/route.js';

const registry = () => createResultActionRegistry([], new Map(), false, new Set(), new Map(), new Set());
const response = (overrides: Partial<ServerExecuteResponse> = {}): ServerExecuteResponse => ({
  recipe_id: 'executed-child', recipe_hash: 'hash-child', run_id: 'run-child-7',
  success: true, output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 7,
  ...overrides,
});
const snapshot = (result: ServerExecuteResponse): RecipesResultPanelSnapshot => ({
  route_recipe_id: 'parent-route', source_recipe_id: 'parent-source',
  render_recipe_id: 'executed-child', origin: 'result-action', result,
});
const render = (panel: RecipesResultPanelSnapshot | null): string =>
  renderRecipeResultPanel(panel, [], registry(), new Map());
const runHref = (html: string): string | undefined =>
  html.match(/href="([^"]*)">Open this run in Logs<\/a>/)?.[1];

describe('result link to its exact Logs run', () => {
  it('uses the response anchor even when route, source and rendered recipe identities differ', () => {
    const href = runHref(render(snapshot(response())));
    expect(href).toBe('#logs/run-child-7');
    expect(parseLogsRunAddress(parseShellRoute(href!))).toEqual({ runId: 'run-child-7' });
  });

  it('keeps URL delimiters and markup within a single encoded run-id segment', () => {
    const runId = 'run/child?x="quoted"&other=%23#tail';
    const html = render(snapshot(response({ run_id: runId })));
    const href = runHref(html)!;
    expect(parseShellRoute(href)).toEqual({ surface: 'logs', segments: [runId] });
    expect(html).not.toContain('x="quoted"');
  });

  it.each([undefined, '', ' \n\t ', 'active', 'recipe'])('omits a link without an addressable anchor (%j)', run_id => {
    expect(runHref(render(snapshot(response({ run_id }))))).toBeUndefined();
  });

  it('has no run link before a result exists', () => {
    expect(runHref(render(null))).toBeUndefined();
  });

  it.each([
    { success: false },
    { awaiting_approval: true, success: false },
    { awaiting_peer: true, success: false },
    { run_terminated: 'killed' as const },
  ])('retains the exact audit link for a non-success outcome (%j)', overrides => {
    expect(runHref(render(snapshot(response(overrides))))).toBe('#logs/run-child-7');
  });

  it('follows the replacement result and never borrows the previous result anchor', () => {
    const previous = snapshot(response({ run_id: 'run-old' }));
    const next = { ...snapshot(response({ run_id: 'run-new' })), previous };
    expect(runHref(render(next))).toBe('#logs/run-new');
    expect(runHref(render({ ...next, result: response({ run_id: undefined }) }))).toBeUndefined();
  });
});
