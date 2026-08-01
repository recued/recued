# Recued — working in this repository

Orientation for AI coding assistants. This file deliberately holds only what is
*not* written down elsewhere; everything structural lives in the documents below
and should be fixed there rather than restated here.

## Read first, in this order

1. [ARCHITECTURE.md](./ARCHITECTURE.md) — the four surfaces, the repository
   layout, the one non-negotiable rule, and how a recipe runs.
2. [CONTRIBUTING.md](./CONTRIBUTING.md) — prerequisites, getting it running, and
   the gate.
3. <https://recued.com/docs> — the concept documentation (execution, grants and
   approvals, the warehouse, audit).

## Two surfaces, not four

This repository is the **server** (`backend/server/`) and the **webclient**
(`apps/webclient/`). The Browser Bridge and the cloud are separate concerns and
are not here. A task that appears to need them is out of scope for this clone —
that is by design, not a missing file.

## Before you edit

- **`packages/` must never import from `backend/`.** `packages/` is portable
  engine code; `backend/server/` is one runtime that consumes it. The reverse
  edge is rejected in review and by boundary tests.
- **Types belong in `packages/contracts/`.** It is the source of truth for
  types, operators, namespaces, and error codes. Redeclaring a shape locally is
  a signal the contract is missing one — raise the gap instead of routing around
  it.
- **Prefer a recipe over engine code.** Recipes are JSON compositions, and most
  behaviour belongs there. Authoring guide:
  <https://recued.com/docs/guides/authoring-recipes/>. Schema reference:
  <https://recued.com/docs/reference/recipe-schema/>. Worked examples — real
  manifests and recipes to read and fork — are in `community/`.
- **Execution is server-side.** Clients render or actuate; they never run the
  engine. Credentials never reach a recipe: a recipe names a connection, and
  only the kernel connection adapter decrypts, at call time.

## Verifying a change

`npm run ci` is the gate — run it before proposing a change is done. While
iterating, run one file: `npx vitest run path/to/file.test.ts`.

Two habits that matter more than the commands:

- **A full-suite run is a weak signal for attribution.** When something is red,
  run that file alone before concluding what caused it.
- **A green test only proves what it asserts.** Before trusting a new test,
  check that it fails when the behaviour it covers is removed. A test that stays
  green either way is documenting nothing.

Report what actually happened. If a step was skipped or a test fails, say so
with the output rather than describing the intent.

## Conventions

- Match the surrounding code's naming, comment density, and idiom.
- Comments cite decisions by number (`D-145`, `D-192`). Those design records are
  not published; each comment is written to stand on its own, and the number is
  there so a maintainer can trace provenance.
- `community/` carries the foundation packs shipped inside the binary. Treat it
  as a reference example — the wider catalog is distributed through the
  marketplace, not this repository.
