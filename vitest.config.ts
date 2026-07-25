import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // Prefer .ts over .js when extensions are omitted.
    extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'],
    alias: [
      // Strip `.js` suffix from relative imports so the TS ESM convention
      // (`import '../cache.js'` → resolves to `cache.ts`) works even when
      // stale compiled `.js` artifacts sit alongside the source. Without
      // this, vitest would pick the stale `.js` and shadow `.ts` edits.
      { find: /^(\.{1,2}\/.+)\.js$/, replacement: '$1' },
      { find: '@recued/contracts', replacement: resolve(__dirname, 'packages/contracts/src') },
      { find: '@recued/transforms', replacement: resolve(__dirname, 'packages/transforms/src') },
      { find: '@recued/engine', replacement: resolve(__dirname, 'packages/engine/src') },
      { find: '@recued/gateway', replacement: resolve(__dirname, 'packages/gateway/src') },
      // `@recued/middleware-recued` MUST precede `@recued/middleware` —
      // Vite alias resolution is prefix-based and the longer match must
      // win, else `@recued/middleware-recued` mis-resolves under
      // `packages/middleware/src-recued`.
      { find: '@recued/middleware-recued', replacement: resolve(__dirname, 'packages/middleware-recued/src') },
      { find: '@recued/middleware', replacement: resolve(__dirname, 'packages/middleware/src') },
      { find: '@recued/provenance', replacement: resolve(__dirname, 'packages/provenance/src') },
      { find: '@recued/social-graph', replacement: resolve(__dirname, 'packages/social-graph/src') },
      { find: '@recued/cache', replacement: resolve(__dirname, 'packages/cache/src') },
      { find: '@recued/config', replacement: resolve(__dirname, 'packages/config/src') },
      { find: '@recued/crypto', replacement: resolve(__dirname, 'packages/crypto/src') },
      // Prefix alias — `@recued/ui-shared/template`, `.../primitives`,
      // `.../action-dispatcher` all resolve under `packages/ui-shared/src/*`.
      { find: '@recued/ui-shared', replacement: resolve(__dirname, 'packages/ui-shared/src') },
      // No prefix collision with `@recued/ingredients` (both share the
      // `@recued/ingredient` stem but diverge at `-`/`s`); order is incidental.
      { find: '@recued/ingredient-authoring', replacement: resolve(__dirname, 'packages/ingredient-authoring/src') },
      { find: '@recued/ingredients', replacement: resolve(__dirname, 'packages/ingredients/src') },
      { find: '@recued/storage', replacement: resolve(__dirname, 'packages/storage/src') },
      { find: '@recued/storage-gate', replacement: resolve(__dirname, 'packages/storage-gate/src') },
      { find: '@recued/fts', replacement: resolve(__dirname, 'packages/fts/src') },
      { find: '@recued/warehouse-events', replacement: resolve(__dirname, 'packages/warehouse-events/src') },
      { find: '@recued/approvals', replacement: resolve(__dirname, 'packages/approvals/src') },
      { find: '@recued/llm', replacement: resolve(__dirname, 'packages/llm/src') },
      { find: '@recued/logger', replacement: resolve(__dirname, 'packages/logger/src') },
      { find: '@recued/recipes', replacement: resolve(__dirname, 'packages/recipes/src') },
      { find: '@recued/marketplace', replacement: resolve(__dirname, 'packages/marketplace/src') },
      { find: '@recued/renderer', replacement: resolve(__dirname, 'packages/renderer/src') },
      // The `@recued/server-network` rule MUST appear before
      // `@recued/server` — Vite alias resolution is prefix-based
      // and the longer match needs to win. Moving this entry below
      // would silently mis-resolve to `backend/server/src-network`.
      { find: '@recued/server-network', replacement: resolve(__dirname, 'packages/server-network/src') },
      { find: '@recued/server-tls', replacement: resolve(__dirname, 'packages/server-tls/src') },
      { find: '@recued/server', replacement: resolve(__dirname, 'backend/server/src') },
    ],
  },
  test: {
    include: [
      'packages/**/*.test.ts',
      'backend/**/*.test.ts',
      'apps/**/*.test.ts',
      'test/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    // Threads share the V8 module graph across test files, cutting
    // aggregate import cost. ~11% wall-clock improvement on a 10-core
    // box. Only 15 files use vi.mock and the SQLite-backed tests are
    // already process-isolated via tmpdirs, so threads is safe here.
    pool: 'threads',
    maxWorkers: 10,
    minWorkers: 4,
  },
});
