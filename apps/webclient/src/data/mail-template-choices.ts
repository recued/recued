/** D-315 §5.2 — the owner's mail templates as a recipe's Settings offer them:
 *  each by its name and where it came from (a recipe, by the recipe's name),
 *  "Open it" in Data → Mail facts → Templates, and "Duplicate to edit". */

import type { MailTemplate, ServerRecipeListEntry } from '@recued/contracts';
import type { MailTemplateChoice, MailTemplateVariableCallers } from '@recued/ui-shared';

export interface MailTemplateChoiceDeps {
  readonly listTemplates: () => Promise<{ templates: readonly MailTemplate[] }>;
  readonly listRecipes: () => Promise<{ recipes: ReadonlyArray<ServerRecipeListEntry> }>;
  readonly duplicateTemplate: (args: { template_id: string }) => Promise<{ template: MailTemplate }>;
  /** Go to an address in the app (`#data/…`). */
  readonly navigate: (hash: string) => void;
}

/** Where one template is edited. */
export const mailTemplateAddress = (template_id: string): string =>
  `#data/mail_fact/templates/${encodeURIComponent(template_id)}`;

export const mailTemplateChoiceOf = (
  template: MailTemplate,
  recipeName: (recipe_id: string) => string,
): MailTemplateChoice => ({
  template_id: template.template_id,
  name: template.name,
  type: template.type,
  active: template.active,
  ...(template.origin.kind === 'recipe' ? { recipe: recipeName(template.origin.recipe) } : {}),
});

export const createMailTemplateVariableCallers = (deps: MailTemplateChoiceDeps): MailTemplateVariableCallers => {
  // A recipe gone from the list is still named, by its id.
  const names = async (): Promise<(recipe_id: string) => string> => {
    const { recipes } = await deps.listRecipes().catch(() => ({ recipes: [] as ServerRecipeListEntry[] }));
    const byId = new Map(recipes.map((entry) => [entry.recipe_id, entry.recipe.metadata?.name ?? entry.recipe_id]));
    return (recipe_id) => byId.get(recipe_id) ?? recipe_id;
  };
  return {
    list: async () => {
      const [{ templates }, recipeName] = await Promise.all([deps.listTemplates(), names()]);
      return templates.map((template) => mailTemplateChoiceOf(template, recipeName));
    },
    open: (template_id) => deps.navigate(mailTemplateAddress(template_id)),
    duplicate: async (template_id) => {
      const [{ template }, recipeName] = await Promise.all([deps.duplicateTemplate({ template_id }), names()]);
      return mailTemplateChoiceOf(template, recipeName);
    },
  };
};
