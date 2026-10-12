/** D-320 phase 3, slice 3d — a recipe names no API connection. An API connection
 *  setting, and a step `connection` naming one, are flagged as advice (`info`) until
 *  the shipped recipes drop theirs (3e). Mail, notification, MCP and peer settings stay. */

import { describe, expect, it } from 'vitest';

import { validateRecipe } from '../validate.js';

const API = { label: 'HubSpot connection', type: 'connection', connection_kind: 'api', default: '' };
const recipe = (variables: Record<string, unknown>, steps: Array<Record<string, unknown>>, prefetch_steps: Array<Record<string, unknown>> = []) => ({
  recipe_id: 'read-the-deal',
  version: 1,
  ttl: 0,
  metadata: { name: 'Read the deal', description: 'One HubSpot read.', author: 'recued-core', tags: [], supported_platforms: [] },
  variables,
  prefetch_steps,
  steps,
  output: { render: [] },
});
const read = (connection?: string) => ({
  id: 'deal',
  op: 'recued-core.hubspot.deal.read',
  ...(connection !== undefined ? { connection } : {}),
  args: { deal_id: '9001' },
});

/** Only this rule's issues, with their severity. */
const issues = (r: Record<string, unknown>) =>
  validateRecipe(r).issues
    .filter((issue) => issue.code === 'api_connection_setting' || issue.code === 'step_names_connection')
    .map((issue) => [issue.severity, issue.code, issue.path]);

describe('D-320 slice 3d — a recipe names no API connection', () => {
  it('warns on an API connection setting and each step naming it', () => {
    const r = recipe({ hubspot: API }, [read('{{config.hubspot}}')], [{ ...read('{{config.hubspot}}'), id: 'pre' }]);
    expect(issues(r)).toEqual([
      ['warn', 'api_connection_setting', 'variables.hubspot'],
      ['warn', 'step_names_connection', 'prefetch_steps[0].connection'],
      ['warn', 'step_names_connection', 'steps[0].connection'],
    ]);
    // ⛔ A warning, never an error (3e): every run checks its own copy, which gives each
    // step that names no connection an API setting (3a), and refuses on an error. So
    // the recipe still validates, installs and runs; the pack audits, which allow no
    // warning, keep it out of the shipped recipes.
    expect(validateRecipe(r).valid).toBe(true);
    expect(validateRecipe(r).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('flags a setting no step names', () => {
    expect(issues(recipe({ crm: API }, [read()]))).toEqual([['warn', 'api_connection_setting', 'variables.crm']]);
  });

  it('leaves a recipe that names no connection', () => {
    expect(issues(recipe({}, [read()]))).toEqual([]);
  });

  it('leaves a step naming a notification setting', () => {
    const notify = { label: 'Send from', type: 'connection', connection_kind: 'notification', default: '' };
    expect(issues(recipe({ hubspot: API, sender: notify }, [read('{{config.sender}}')])))
      .toEqual([['warn', 'api_connection_setting', 'variables.hubspot']]);
  });

  it("the validator's connection errors say to leave `connection` out, not to declare a setting", () => {
    const messages = (r: Record<string, unknown>, code: string) =>
      validateRecipe(r).issues.filter((issue) => issue.code === code).map((issue) => issue.message);
    const LEAVE = 'Leave it out, and the step uses the connection chosen for its pack';
    expect(messages(recipe({}, [read('hubspot-key')]), 'op_step_connection_shape')).toEqual([expect.stringContaining(LEAVE)]);
    expect(messages(recipe({}, [read('{{config.ghost}}')]), 'op_step_connection_unknown_variable'))
      .toEqual([expect.stringContaining(LEAVE)]);
    const two = recipe({ a: API, b: API }, [{ ...read(), op: 'deal.search', args: {} }]);
    expect(messages(two, 'op_step_connection_ambiguous'))
      .toEqual([expect.stringContaining('remove the API connection settings: a step that names none uses the connection chosen for its pack')]);
  });

  it.each([
    ['a notification setting', { label: 'Send from', type: 'connection', connection_kind: 'notification', default: '' }],
    ['an MCP setting', { label: 'Server', type: 'connection', connection_kind: 'mcp', default: '' }],
    ['a peer setting, which names no kind', { label: 'Peer', type: 'connection', default: '' }],
    ['a text setting', { label: 'Deal', type: 'string', default: '' }],
  ])('leaves %s', (_name, setting) => {
    expect(issues(recipe({ sender: setting }, [read()]))).toEqual([]);
  });
});
