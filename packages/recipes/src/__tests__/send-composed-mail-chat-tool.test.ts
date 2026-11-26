import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { deriveTier2ArgSchema, isRecipeChatExposed } from '../chat-catalog.js';

/** Chat can send an email with files attached (owner, 2026-10-10: "let Chat run
 *  send-composed-mail"). `file.search` had long told the model a `file_id` could
 *  go "to a recipe that takes files, such as attaching one to an email", while no
 *  recipe in the Chat catalog could: this one was `chat_exposed: false`. */
const recipe = JSON.parse(readFileSync(
  new URL('../../../../community/recipes/send-composed-mail.json', import.meta.url), 'utf8',
)) as RecipeDefinition;
const props = (r: RecipeDefinition): Record<string, Record<string, unknown>> =>
  deriveTier2ArgSchema(r).properties as Record<string, Record<string, unknown>>;

describe('send-composed-mail as a Chat tool', () => {
  it('is in the Chat catalog, stopping at the approval gate as from the compose window', () => {
    expect(isRecipeChatExposed(recipe)).toBe(true);
    expect(recipe.metadata.description).toContain('stops at the approval gate first');
  });

  it('takes attachments as a list of file ids, not as one string', () => {
    expect(props(recipe).attachments).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(props(recipe).to).toMatchObject({ type: 'array' });
  });

  it('asks for no delivery reference: one the model made up could match another email', () => {
    const required = (deriveTier2ArgSchema(recipe).required as string[] | undefined) ?? [];
    expect(required).not.toContain('reconciliation_id');
    expect(props(recipe).reconciliation_id.description).toContain('Optional');
  });
});

describe('a `file_ref[]` variable', () => {
  it('projects as an array of strings', () => {
    const r = {
      recipe_id: 'attach-files',
      variables: { files: { label: 'Files', type: 'file_ref[]', default: [] } },
    } as unknown as RecipeDefinition;
    expect(props(r).files).toEqual({ type: 'array', items: { type: 'string' }, description: 'Files', default: [] });
  });
});
