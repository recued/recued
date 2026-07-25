import type { IngredientCategory } from './ingredient.js';

export interface VaultRow {
  key: string;
  value: string;
  publisher_id: string;
  encrypted: boolean;
}

/** Cache floor enforcement — engine uses max(recipe.ttl, MIN_TTL[category]). */
export const MIN_TTL: Record<IngredientCategory, number> = {
  data: 60,
  ai: 300,
  action: 60,
};
