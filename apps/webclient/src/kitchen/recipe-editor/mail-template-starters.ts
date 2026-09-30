/** D-315 §5.2 — the author's side of a recipe's `mail_template` settings in
 *  Kitchen: which of the author's templates a setting's starter was copied
 *  from, and whether that template changed since. Pure, so a test needs no
 *  editor. */

import {
  mailTemplateDefinitionOf,
  MAIL_TEMPLATE_VARIABLE_TYPE,
  type MailTemplate,
  type MailTemplateDefinition,
  type RecipeDefinition,
} from '@recued/contracts';

/** A recipe's `mail_template` settings, in the order it declares them. */
export const mailTemplateVariableNames = (recipe: Pick<RecipeDefinition, 'variables'>): string[] =>
  Object.entries(recipe.variables ?? {})
    .filter(([, hint]) =>
      hint !== null && typeof hint === 'object' && !Array.isArray(hint)
      && (hint as { type?: unknown }).type === MAIL_TEMPLATE_VARIABLE_TYPE)
    .map(([name]) => name);

/** The starter a setting carries, when its shape is one. */
export const starterOf = (hint: unknown): MailTemplateDefinition | null => {
  const starter = (hint as { starter?: unknown } | null)?.starter;
  if (starter === null || typeof starter !== 'object' || Array.isArray(starter)) return null;
  const s = starter as Partial<MailTemplateDefinition>;
  return typeof s.name === 'string' && typeof s.type === 'string' && s.entrance !== undefined && Array.isArray(s.rules)
    ? (s as MailTemplateDefinition)
    : null;
};

const conditionsKey = (definition: Pick<MailTemplateDefinition, 'entrance'>): string =>
  JSON.stringify(definition.entrance.conditions.map((condition) =>
    [condition.field, condition.op, condition.value, condition.negate === true]));

/** The author's template a starter was copied from: of its kind, with the same
 *  entrance, or else the same name. `null` when none is — the author picks. */
export const starterSourceOf = (
  starter: MailTemplateDefinition,
  templates: readonly MailTemplate[],
): MailTemplate | null => {
  const ofKind = templates.filter((template) => template.type === starter.type);
  const key = conditionsKey(starter);
  return ofKind.find((template) => conditionsKey(template) === key)
    ?? ofKind.find((template) => template.name === starter.name)
    ?? null;
};

/** The author's template changed since the recipe took its copy: "Update from
 *  my template" would bring something new. */
export const starterChanged = (starter: MailTemplateDefinition, source: MailTemplate): boolean =>
  JSON.stringify(mailTemplateDefinitionOf(source)) !== JSON.stringify(mailTemplateDefinitionOf(starter));
