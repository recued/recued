/** D-345 slice B — the HTTP Toolkit's actions as the kernel's `http-get`, `http-read` and
 *  `http-download` answer them: an action's refusal becomes the ingredient error a recipe step reports,
 *  its words kept. Loaded on first use (`wire-executor-config.ts`). */
import { IngredientError } from '@recued/ingredients';

import { HttpActionError } from './http-actions.js';

export { httpDownload, httpGet, httpRead } from './http-actions.js';

/** The ingredient error each refusal is: a blocked address as a blocked endpoint, a site that did
 *  not answer as a network error. */
const CODES: Readonly<Record<HttpActionError['code'], string>> = {
  BAD_INPUT: 'BAD_INPUT',
  NOT_TEXT: 'BAD_INPUT',
  NOT_PUBLIC: 'INGREDIENT_ENDPOINT_BLOCKED',
  FETCH_FAILED: 'NETWORK_ERROR',
  TOO_LARGE: 'VALUE_TOO_LARGE',
};

/** `run()`'s answer, or its refusal as an ingredient error naming `slug`. */
export const ingredientErrorOf = async (slug: string, run: () => Promise<object>): Promise<Record<string, unknown>> => {
  try {
    return { ...(await run()) } as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpActionError) throw new IngredientError(CODES[error.code], error.message, { slug });
    throw error;
  }
};
