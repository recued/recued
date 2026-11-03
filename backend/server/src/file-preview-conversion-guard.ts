/** Host-only input check retained while a preview waits for approval. The
 * checkpoint keeps the recipe id, never a closure or a grant. A restart loses
 * this check and refuses materialization rather than converting a new version. */
export const PREVIEW_CONVERSION_RECIPE_PREFIX = 'preview-work-document-';
const guards = new Map<string, { validate(record: unknown): number; read?: (hash: string) => void }>();
export const registerPreviewConversionInput = (recipe: string, validate: (record: unknown) => number,
  read?: (hash: string) => void): (() => void) => {
  const guard = { validate, ...(read ? { read } : {}) }; guards.set(recipe, guard);
  return () => { if (guards.get(recipe) === guard) guards.delete(recipe); };
};
export const assertPreviewConversionInput = (recipe: string | undefined, record: unknown): number | undefined => {
  if (!recipe?.startsWith(PREVIEW_CONVERSION_RECIPE_PREFIX)) return undefined;
  const guard = guards.get(recipe);
  if (!guard) throw new Error('The temporary preview request is no longer available. Open the file and convert it again.');
  return guard.validate(record);
};
export const recordPreviewConversionRead = (recipe: string | undefined, record: unknown, hash: string): void => {
  if (!recipe?.startsWith(PREVIEW_CONVERSION_RECIPE_PREFIX)) return;
  assertPreviewConversionInput(recipe, record); guards.get(recipe)!.read?.(hash);
};
