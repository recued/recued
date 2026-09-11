import { describe, expect, it } from 'vitest';
import { createEditorHistory, readEditorDraft, writeEditorDraft, type EditorSnapshot } from '../editor-history.js';
import { parseEditorValue } from '../value-editor.js';

const initial = (): EditorSnapshot => ({
  recipe: { recipe_id: 'sample', version: 1, ttl: 300,
    metadata: { name: 'Sample', description: '', author: '', supported_platforms: [] },
    variables: {}, prefetch_steps: [], steps: [], output: { render: [] } }, fields: {},
});

describe('editor value drafts', () => {
  it('can replace an untyped reference with a typed literal', () => {
    expect(parseEditorValue('[1,2]', '{{step.read}}')).toEqual({ value: [1, 2] });
    expect(parseEditorValue('42', '{{config.count}}')).toEqual({ value: 42 });
  });
  it('uses the schema for empty fields and preserves typed values', () => {
    expect(parseEditorValue('[1,2]', null, { type: 'array' })).toEqual({ value: [1, 2] });
    expect(parseEditorValue('3.5', undefined, { type: 'number' })).toEqual({ value: 3.5 });
    expect(parseEditorValue('amount', undefined, { type: 'string' })).toEqual({ value: 'amount' });
    expect(parseEditorValue('false', null, { type: 'boolean' })).toEqual({ value: false });
  });
  it('preserves references nested in structured JSON without turning the object into a string', () => {
    expect(parseEditorValue('{"value":"{{step.read}}"}', {}, { type: 'object' }))
      .toEqual({ value: { value: '{{step.read}}' } });
    expect(parseEditorValue('{{step.read}}', [], { type: 'array' })).toEqual({ value: '{{step.read}}' });
    expect(parseEditorValue('Hello {{config.name}}', '', { type: 'string' })).toEqual({ value: 'Hello {{config.name}}' });
  });
  it('refuses unfinished and wrong-shape JSON instead of coercing or overwriting it', () => {
    expect(parseEditorValue('[1,', [], { type: 'array' }).error).toBeTruthy();
    expect(parseEditorValue('{"x":1}', [], { type: 'array' }).error).toBeTruthy();
    expect(parseEditorValue('"abc"', 3, { type: 'number' }).error).toBeTruthy();
    expect(parseEditorValue('', [1], { type: 'array' })).toEqual({ value: undefined });
  });
});

describe('editor history and recovery', () => {
  it('keeps the saved revision across undo and redo without adding an edit', () => {
    const history = createEditorHistory(initial());
    const changed = initial(); changed.recipe.ttl = 900; history.record(changed);
    history.updateVersion('sample', 2);
    expect(history.undo()?.recipe).toMatchObject({ version: 2, ttl: 300 });
    expect(history.redo()?.recipe).toMatchObject({ version: 2, ttl: 900 });
    expect(history.canRedo).toBe(false);
  });
  it('coalesces typing, preserves invalid text, and invalidates redo after a new edit', () => {
    const start = initial(); const history = createEditorHistory(start);
    const one = initial(); one.recipe.metadata.name = 'S';
    history.record(one, 'name', 10);
    one.recipe.metadata.name = 'Sam'; history.record(one, 'name', 20);
    const two = structuredClone(one); two.fields['["s","param:array"]'] = { text: '[1,', error: 'unfinished' };
    history.record(two, 'array', 30);
    expect(history.undo()).toEqual(one);
    expect(history.undo()).toEqual(start);
    expect(history.redo()).toEqual(one);
    history.record(two, 'other', 40);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toEqual(one);
  });
  it('bounds history while retaining the current document', () => {
    const history = createEditorHistory(initial(), 2);
    for (let i = 0; i < 4; i++) { const next = initial(); next.recipe.ttl = i; history.record(next); }
    expect(history.undo()?.recipe.ttl).toBe(2);
    expect(history.undo()?.recipe.ttl).toBe(1);
    expect(history.undo()).toBeNull();
  });
  it('isolates server/recipe identities and persists unfinished JSON with its base', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const recovery = { key: 'server-a:recipe-a', storage };
    const snapshot = initial(); snapshot.fields['["","output"]'] = { text: '{', error: 'unfinished' };
    const draft = { base: initial().recipe, snapshot };
    expect(writeEditorDraft(recovery, draft)).toBe(true);
    expect(readEditorDraft(recovery)).toEqual(draft);
    expect(readEditorDraft({ ...recovery, key: 'server-b:recipe-a' })).toBeNull();
    expect(writeEditorDraft(recovery, null)).toBe(true);
    expect(readEditorDraft(recovery)).toBeNull();
  });
  it('fails softly when storage is unavailable or corrupt', () => {
    const recovery = { key: 'x', storage: { getItem: () => '{', setItem: () => { throw new Error('quota'); }, removeItem: () => {} } };
    expect(readEditorDraft(recovery)).toBeNull();
    expect(writeEditorDraft(recovery, { base: initial().recipe, snapshot: initial() })).toBe(false);
  });
});
