import { defineConfig } from 'vitest/config';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';

/** What makes a `packages/` test file unsafe to share a worker process with the files
 *  after it: a module mock, a stubbed global or env var, fake timers, a module-registry
 *  reset, or a direct write to `process.env`, a global, the cwd or the umask. Without
 *  isolation, whatever one file leaves behind is what the next file in that worker sees. */
const SHARES_PROCESS_STATE = [
  /\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock|stubGlobal|stubEnv|resetModules|useFakeTimers)\s*\(/,
  /\bprocess\.env\b(?:\.[\w$]+|\[[^\]]+\])?\s*=(?!=)|\bdelete\s+process\.env\b|Object\.assign\(\s*process\.env\b/,
  /\b(?:globalThis|global)\.[\w$]+\s*=(?!=)/,
  /\bprocess\.(?:chdir|umask)\s*\(/,
];

const testFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.cache') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });

/** A path as a glob that matches only itself. */
const literalGlob = (path: string): string => path.split(sep).join('/').replace(/[*?[\]{}()!+@]/g, '\\$&');

/** Read at config load, not kept as a list: a test that starts mocking tomorrow is
 *  isolated tomorrow, and there is no list for anyone to forget to update.
 *  ⚠ `extends: true` (in `projects`) evaluates this file once per project — five times per
 *  vitest start — so each root's scan (~75 ms for `packages/`) is remembered on the process
 *  instead of repeated. */
const keptIsolatedUnder = (root: string): string[] => testFilesUnder(resolve(__dirname, root))
  .filter((file) => {
    const source = readFileSync(file, 'utf8');
    return SHARES_PROCESS_STATE.some((pattern) => pattern.test(source));
  })
  .map((file) => literalGlob(relative(__dirname, file)));
const memo = globalThis as {
  __recuedPackagesKeptIsolated?: string[]; __recuedBackendKeptIsolated?: string[]; __recuedAppsKeptIsolated?: string[];
};
const PACKAGES_KEPT_ISOLATED = memo.__recuedPackagesKeptIsolated ??= keptIsolatedUnder('packages');
const BACKEND_KEPT_ISOLATED = memo.__recuedBackendKeptIsolated ??= keptIsolatedUnder('backend');
const APPS_KEPT_ISOLATED = memo.__recuedAppsKeptIsolated ??= keptIsolatedUnder('apps');

/** ⛔ THE CODING-AGENT LIVE DRIVES RUN ONLY WHEN ASKED FOR: `npm run test:live-drives`.
 *
 *  Each drives a REAL installed agent CLI (opencode, pi, claude, codex) through its pack, so
 *  what it tests is this machine's copy of that CLI as much as the commit: the opencode upgrade
 *  1.15 → 1.18 turned them red on 2026-10-08 with no commit at all. And they were the heaviest
 *  tests per case in the suite, ~209 s of a sweep's 2,117 s of test time. Owner decision
 *  2026-10-09: out of the full suite (the sweeps, `npm test`, and so the release, which runs
 *  `npm test`), into a command of their own. ⇒ Run it after changing one of these packs or
 *  `cli-invocation-executor.ts`; one file: `RECUED_LIVE_DRIVES=1 npx vitest run <file>`, and all of
 *  them `RECUED_LIVE_DRIVES=1 npx vitest run live-drive` (the script is not in the public tree's
 *  package.json, which is generated).
 *  Each still skips itself when its CLI is not installed.
 *
 *  ⚠ A NAMED LIST: a new drive of this kind runs in the full suite until it is added here,
 *  which is the safe way round. The local-tool live drives (tesseract, ripgrep, officecli,
 *  face_recognition) are cheap and stay in. */
const AGENT_CLI_LIVE_DRIVES = [
  'backend/server/src/__tests__/opencode-pack-live-drive.test.ts',
  'backend/server/src/__tests__/issue-pipeline-agents-live-drive.test.ts',
  'backend/server/src/__tests__/claude-code-pack-live-drive.test.ts',
  'backend/server/src/__tests__/codex-pack-live-drive.test.ts',
  'backend/server/src/__tests__/pi-agent-pack-live-drive.test.ts',
];
const LIVE_DRIVES_ASKED_FOR = process.env.RECUED_LIVE_DRIVES === '1';

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
    // The five test roots are named in `projects` below.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      /* ⛔⛔ THE VENDORED CORPUS UNDER `.cache/` IS NOT OURS AND MUST NOT BE COLLECTED.
       *  `scripts/breadth/.cache/` holds four cloned repos (codex, hermes, openclaw,
       *  openfang, 1.6 GB) and `scripts/**` (in `projects` below) globs straight into
       *  them: of the 19,867 files vitest collected before this line, 16,148 —
       *  EIGHTY-ONE PERCENT — were theirs. They fail in bulk, because they are being run
       *  outside their own repo with our config, our pool and none of their fixtures.
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
      // Unless asked for — see `AGENT_CLI_LIVE_DRIVES`.
      ...(LIVE_DRIVES_ASKED_FOR ? [] : AGENT_CLI_LIVE_DRIVES),
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
    // ⛔⛔ NO `maxWorkers` IN THIS FILE. Each project below `extends: true`, so it would inherit
    // the value — and vitest reads a project's own `maxWorkers` BEFORE the command line's
    // (`resolveMaxWorkers`). With `maxWorkers: 10` here, `--maxWorkers 2` ran 10 workers
    // (measured 2026-10-08): the sweep's cap of 6 and `test:ci`'s 4 were silently ignored.
    // Unset, a run takes `--maxWorkers` when given and vitest's default (CPUs − 1) when not.
    // (`minWorkers` went with it: vitest 4 has no such option.)
    // ⚠ vitest copies only some command-line options into projects (`testTimeout`, `pool`,
    // `isolate`, `sequence`, `bail`, `retry`, …; `resolveProjects`). `--hookTimeout` is not
    // one and has no fallback, so `hookTimeout` above wins over the flag.
    /** ⛔ FOUR PROJECTS: most of `packages/`, `backend/` and `apps/` share worker processes; the
     *  rest is isolated.
     *
     *  Isolation (vitest's default) starts every test file in a fresh process that reloads its
     *  whole module graph. Measured 2026-10-08: loading `@recued/contracts` alone costs ~0.5 s
     *  per file (334 modules — 59% of import time in a sample of the backend tests), and the full
     *  suite spent 40% of its worker time importing. With `isolate: false` a worker keeps its
     *  loaded modules for the next file: `packages/` (1,510 files, 6 workers) went 194 s → 95 s,
     *  import 713 s → 121 s, all 31,074 tests green in default AND shuffled file order.
     *
     *  ⚠ THE PRICE IS SHARED STATE. Between files in one worker, vitest restores spies and its
     *  own config, and nothing else. So a `packages/` file that touches process-wide state at all
     *  (`SHARES_PROCESS_STATE`, above) stays isolated. That check reads the TEST FILE only:
     *  module-level state in the code under test, or a helper that stubs on a test's behalf,
     *  is not caught. A failure in a `|no-isolate|` file that passes when run alone is the
     *  first thing to suspect of it.
     *
     *  ⚠ Peak worker memory rose 2.7 → 4.0 GB in that measurement — vitest sets no memory cap
     *  on reused `forks` workers.
     *
     *  🏁 `backend/` SHARES TOO, SINCE 2026-10-09 (`backend-shared`), behind one reset. Tried on
     *  2026-10-08, 60-61 files failed: the composed server installs a process-wide vendor-alias
     *  resolver (`compose-app-context.ts`, into `packages/contracts/src/vendor-alias-registry.ts`)
     *  that reads ITS database and is never removed, so the next file in that worker read a closed
     *  one. That was the whole of it. With the resolver put back after every file
     *  (`backend/server/src/__tests__/helpers/shared-worker-reset.ts`), all 2,102 backend files
     *  passed in default AND shuffled order, in 259 s and 331 s against 477 s isolated (6 workers,
     *  nice 19): import 1,278 s → 241-352 s, test time level at ~1,230 s. (The 10-08 run's test time
     *  had RISEN to 2,310 s — the failures' own cost, which is why that run looked like no gain.)
     *  Worker memory peaked at 1.6 GB, 4.6 GB for all six.
     *  🏁 `apps/` SHARES TOO (`apps-shared`, 2026-10-09), and needed no reset: its 448 files ran in
     *  Node with no DOM environment, and all 9,453 tests passed in default AND shuffled order, in
     *  31 s and 30 s against 61 s isolated (6 workers, nice 19; import 245 s → 112 s).
     *  ⚠ A new process-wide setter in server composition needs a line in that reset. Its symptom is
     *  a `|backend-shared|` file failing on what an earlier file left (a closed database, another
     *  test's registry) while passing alone. */
    projects: [
      {
        extends: true,
        test: {
          name: 'isolated',
          include: [
            ...PACKAGES_KEPT_ISOLATED,
            ...BACKEND_KEPT_ISOLATED,
            ...APPS_KEPT_ISOLATED,
            'test/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'no-isolate',
          include: ['packages/**/*.test.ts'],
          exclude: PACKAGES_KEPT_ISOLATED,
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'backend-shared',
          include: ['backend/**/*.test.ts'],
          exclude: BACKEND_KEPT_ISOLATED,
          isolate: false,
          setupFiles: ['backend/server/src/__tests__/helpers/shared-worker-reset.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'apps-shared',
          include: ['apps/**/*.test.ts'],
          exclude: APPS_KEPT_ISOLATED,
          isolate: false,
        },
      },
    ],
  },
});
