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
    /** ⛔ NOT vitest's 5s default. This suite boots real servers, opens real
     *  SQLite files, does real key work and drives real WebSocket closes — and
     *  the release's step-5 run does it in a freshly `npm ci`'d tree at full
     *  parallelism across 45,846 tests.
     *
     *  Under that load the 5s default produced THREE failures per run, and a
     *  DIFFERENT three each time: 5.3s / 7.6s / 10.1s on one pass, 5.8s / 5.8s
     *  on the previous. Every one of them passes standalone. Failures that move
     *  between runs are a ceiling, not a defect, and patching them one at a time
     *  is how each release rediscovers the same hour.
     *
     *  ⚠ 30s is still a CEILING — a genuinely hung test fails, it just fails
     *  honestly. Tests that do real work also carry explicit per-test timeouts;
     *  those stay, because they document WHICH tests those are. */
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
      /* ⛔⛔ THE VENDORED CORPUS UNDER `.cache/` IS NOT OURS AND MUST NOT BE COLLECTED.
       *  `scripts/breadth/.cache/` holds four cloned repos (codex, hermes, openclaw,
       *  openfang, 1.6 GB) and `scripts/**` above globs straight into them: of the 19,867
       *  files vitest collected before this line, 16,148 — EIGHTY-ONE PERCENT — were
       *  theirs. They fail in bulk, because they are being run outside their own repo
       *  with our config, our pool and none of their fixtures.
       *
       *  ⚠ THE COST IS NOT THE WASTED TIME, IT IS THAT "THE SUITE IS RED" STOPS MEANING
       *  ANYTHING. `vitest run test` and `vitest run scripts` are SUBSTRING filters, so
       *  both sweep the cache and report thousands of failures that belong to nobody
       *  here — 4,629 in one run on 2026-09-14. A reader cannot tell that from a real
       *  regression without reading the paths, and the honest reading ("797 files
       *  failing") is the wrong one. This burned three separate runs before it was fixed.
       *
       *  ⚠ `.cache/` IS ALREADY IN `.gitignore` (line 125) AND THAT DOES NOTHING HERE —
       *  vitest globs the filesystem and never consults git. An ignore rule and a
       *  collection rule are different mechanisms; the first one existing is exactly why
       *  nobody expected to need the second.
       *
       *  Matched on `.cache` rather than on `breadth`, so a cache dir added anywhere else
       *  is covered on the day it appears rather than after it has cost someone a run. */
      '**/.cache/**',
    ],
    // ⛔⛔⛔ FORKS, AND THIS IS NOT A PREFERENCE. The threads pool DIES on the
    // backend suite: SIGSEGV (exit 139) with zero test failures, reproducible
    // 6/6 at maxWorkers 10, 4, 2 AND 1 — so it is not contention — and
    // identically on Node 24 LTS and Node 25, so it is not the Node major
    // either. Every crash stack bottoms out in `node::worker::Worker::Run` /
    // `MessagePort::OnMessage`; forks spawns child PROCESSES and never
    // constructs a worker thread, so that code path is absent rather than
    // merely rarer. Measured 2026-08-19: forks 10/10 clean runs (incl. three
    // full five-root sweeps, 75,903 tests), threads 0/6.
    //
    // ⚠ THE PRIOR COMMENT HERE SAID "threads is safe" AND WAS WRONG BY THREE
    // MONTHS. `feedback_vitest_pool_forks` recorded the hang on 2026-05-23 and
    // `reference_session_env_backend_suite` re-derived it on 2026-08-08
    // ("the death is the WORKER pool, not a file … prefer forks by default"),
    // while this file kept asserting the opposite — so every fresh `npx vitest
    // run` walked into it. That is why the fix belongs HERE and not only in
    // `scripts/vitest.sh`, which has forced `--pool forks` since May: a remedy
    // that lives only in a wrapper protects only the people who know about it.
    //
    // The cost is real and accepted: ~2x wall-clock (≈340s → ≈640s on the full
    // sweep) because each worker pays its own import graph. A suite that
    // finishes slowly beats one that segfaults.
    pool: 'forks',
    maxWorkers: 10,
    minWorkers: 4,
  },
});
