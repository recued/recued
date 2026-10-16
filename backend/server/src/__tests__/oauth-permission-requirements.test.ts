import { describe, expect, it } from 'vitest';
import type { IngredientManifest, RecipeDefinition, ManagedOAuthConnectionUse } from '@recued/contracts';
import { readOAuthPermissionRequirements, readNativeOAuthPermissionRequirements } from '../oauth-permission-requirements.js';
import type { CollectionInstanceRecord } from '../collections/instance-store.js';
const manifest = (required_scopes?: string[]): IngredientManifest => ({ slug: 'sheets', name: 'Sheets', description: 'Fixture', author: 'fixture', version: 1,
  category: 'action', risk_tier: 'read', input: {}, output: {}, kind: 'http', operations: {
  read: { operation_id: 'read', risk_tier: 'read', ...(required_scopes ? { required_scopes } : {}) },
} });
const pack: ManagedOAuthConnectionUse = { kind: 'pack', id: 'pack', label: 'Spreadsheet pack' };
const recipe = (steps: RecipeDefinition['steps']): RecipeDefinition => ({ recipe_id: 'recipe', version: 1, ttl: 0,
  metadata: { name: 'Read sheet', description: 'Fixture', author: 'fixture', supported_platforms: [] }, prefetch_steps: [], steps, variables: {}, output: { render: [] } });
const fixture = () => ({ uses: [pack], complete: true,
  bindings: [{ connection_name: 'work', catalog_slug: 'sheets', installed_pack_id: 'pack' }],
  manifest: () => manifest(['spreadsheets.readonly']), recipe: () => recipe([{ id: 'one', ingredient: 'sheets', connection: 'work', input: { operation: 'read' } }]),
});

const nativeRow = (): CollectionInstanceRecord => ({ platform: 'mail', slug: 'work', adapter_type: 'graph', config: { native_send_enabled: false },
  caps: { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'required', auth: 'oauth', path_style: 'uri' }, auth_state: 'healthy',
  created_at: 1, updated_at: 1, last_synced_at: 1, backfill_complete: false });
describe('native Mail and Calendar workflow permission requirements', () => {
  const readNative = (steps: RecipeDefinition['steps'], row = nativeRow()) => readNativeOAuthPermissionRequirements(row, {
    complete: true, recipes: [{ recipe: recipe(steps), pack }], dishes: [{ dish_id: 'dish', recipe_id: 'recipe', name: 'Saved run', enabled: false }],
    schedules: [{ schedule_id: 'paused', recipe_id: 'recipe', enabled: false }] });
  it('protects send scopes used by installed workflows even when the local send switch is off', () => {
    const result = readNative([{ id: 'send', op: 'core.mail.send', args: { sender_mail_instance: 'work' } }]);
    expect(result.complete).toBe(true); expect(result.requirements.map(r => r.scope)).toEqual(expect.arrayContaining(['Mail.Read', 'Mail.Send', 'Mail.ReadWrite']));
    expect(result.uses).toEqual(expect.arrayContaining([pack, { kind: 'schedule', id: 'paused', label: 'Read sheet', paused: true }]));
  });
  it('reads lowered kernel ingredients and keeps dynamic mailbox selection as possible usage', () => {
    const result = readNative([{ id: 'send', ingredient: 'mail-send', input: { sender_mail_instance: '{{config.mailbox}}' } }]);
    expect(result.requirements.map(r => r.scope)).toContain('Mail.Send'); expect(result.uses?.every(use => use.may_use)).toBe(true);
  });
  it('does not assign a literal different mailbox to this account', () => {
    expect(readNative([{ id: 'send', op: 'core.mail.send', args: { sender_mail_instance: 'other' } }]).requirements).toEqual([]);
  });
  it('protects native calendar event permissions independently of the current local edit switch', () => {
    const row = { ...nativeRow(), platform: 'calendar' as const, adapter_type: 'gcal', config: { native_write_enabled: false } };
    const result = readNative([{ id: 'edit', op: 'core.data.calendar.update', args: { slug: 'work' } }], row);
    expect(result.requirements.map(r => r.scope)).toContain('https://www.googleapis.com/auth/calendar.events');
  });
  it('keeps provider draft-save requirements while local draft edits add no vendor scopes', () => {
    const result = readNative([{ id: 'draft', op: 'core.mail.draft.save-to-mailbox', args: { draft_id: 'draft' } }]);
    expect(result.complete).toBe(true); expect(result.requirements.map(r => r.scope)).toContain('Mail.ReadWrite');
    expect(readNative([{ id: 'draft', op: 'core.mail.draft.create', args: {} }]).requirements).toEqual([]);
  });
});
describe('current OAuth permission requirements', () => {
  it('attributes requirements to exact installed connection catalog bindings', () => {
    const deps = fixture(); expect(readOAuthPermissionRequirements('work', deps)).toMatchObject({ complete: true,
      requirements: [{ scope: 'spreadsheets.readonly', uses: [pack] }] });
    expect(readOAuthPermissionRequirements('other', { ...deps, uses: [] }).requirements).toEqual([]);
  });
  it('does not retain an uninstalled pack after its binding and recipes are gone', () => {
    expect(readOAuthPermissionRequirements('work', { ...fixture(), bindings: [], uses: [] })).toEqual({ complete: true, requirements: [], warnings: [] });
  });
  it('keeps standalone recipes, dishes and paused schedules in the inventory', () => {
    const deps = fixture(); const use: ManagedOAuthConnectionUse = { kind: 'recipe', id: 'recipe', label: 'Read sheet' };
    const result = readOAuthPermissionRequirements('work', { ...deps, uses: [use, { kind: 'schedule', id: 'nightly', label: 'Nightly', paused: true }], bindings: [] });
    expect(result).toMatchObject({ complete: true, requirements: [{ scope: 'spreadsheets.readonly', uses: [use] }] });
  });
  it.each(['missing catalog', 'missing scope metadata', 'missing recipe', 'dynamic operation', 'schedule without recipe', 'pack without binding'])('keeps %s unknown', mode => {
    const deps = fixture(); const result = readOAuthPermissionRequirements('work', { ...deps,
      uses: mode === 'schedule without recipe' ? [{ kind: 'schedule', id: 'schedule', label: 'Paused', paused: true }]
        : mode === 'missing recipe' || mode === 'dynamic operation' ? [{ kind: 'recipe', id: 'recipe', label: 'Recipe' }] : deps.uses,
      bindings: mode === 'pack without binding' ? [] : deps.bindings,
      manifest: () => mode === 'missing catalog' ? null : mode === 'missing scope metadata' ? manifest() : deps.manifest(),
      recipe: () => mode === 'missing recipe' ? null : mode === 'dynamic operation' ? recipe([{ id: 'one', op: 'dynamic', args: {} }]) : deps.recipe(),
    }); expect(result.complete).toBe(false);
  });
});
