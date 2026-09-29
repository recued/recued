/** Is a model's date argument the date its declared format says it is?
 *
 *  One check for every door a recipe's arguments come through from a model:
 *  the owner's chat and MCP (`createChatTier2Dispatch`) and the contracted
 *  gateway (`validateGatewaySchemaValue`). Before it, only the gateway looked,
 *  so the owner's own chat handed a recipe whatever the model wrote.
 *
 *  - `date` (a `date` setting) is a calendar day that exists: `YYYY-MM-DD`,
 *    checked by `calendarDayMs` — `Date.parse('2026-02-30')` is 2 March.
 *  - `date-time` (a `datetime` setting) is anything `Date.parse` reads, as the
 *    recipe's own `date_parse` would. An offset is not required: a bare day is
 *    a legitimate answer to "remind me on the 1st".
 *  - A blank is no value, not a bad one: many `datetime` settings default to
 *    `''` and say "leave blank". */

import { calendarDayMs, type RecipeDefinition } from '@recued/contracts';

export const dateFormatIssue = (format: unknown, value: string, path: string): string | null => {
  if (value.trim() === '') return null;
  if (format === 'date' && calendarDayMs(value) === null) {
    return `${path} must be a date as YYYY-MM-DD`;
  }
  if (format === 'date-time' && Number.isNaN(Date.parse(value))) {
    return `${path} must be an ISO 8601 date-time string`;
  }
  return null;
};

/** The first `date` / `datetime` setting whose string argument is not one.
 *  Other types, and values that are not strings, are left to the recipe. */
export const recipeDateArgumentIssue = (
  recipe: Pick<RecipeDefinition, 'variables'>,
  args: Record<string, unknown>,
): string | null => {
  for (const [key, hint] of Object.entries(recipe.variables ?? {})) {
    const value = args[key];
    if (typeof value !== 'string' || hint === null || typeof hint !== 'object' || Array.isArray(hint)) {
      continue;
    }
    const type = (hint as { type?: unknown }).type;
    if (type !== 'date' && type !== 'datetime') continue;
    const issue = dateFormatIssue(type === 'date' ? 'date' : 'date-time', value, key);
    if (issue !== null) return issue;
  }
  return null;
};
