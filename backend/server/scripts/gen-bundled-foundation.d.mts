/** Type declarations for the JS codegen so the drift test can import its pure
 *  derivation under `tsc`. The script itself stays plain `.mjs` (runs via
 *  `node` in the build / `npm run gen:foundation`). */
export interface FoundationBundle {
  packs: Array<Record<string, unknown> & { slug: string; recipes?: Array<{ slug: string }> }>;
  recipes: Record<string, Record<string, unknown> & { recipe_id?: string }>;
}
/** Read `community/` under `repoRoot` → the foundation embed shape (throws on a
 *  missing referenced recipe file). Deterministic order. */
export function deriveFoundationBundle(repoRoot: string): FoundationBundle;
/** Render the generated `.ts` module source from a derived bundle. */
export function renderBundleModule(bundle: FoundationBundle): string;
