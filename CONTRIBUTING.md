# Contributing

Thanks for looking at Recued. This file covers working on the codebase. For
installing and using Recued, see <https://recued.com/docs>; for how the pieces
fit together, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Prerequisites

- Node.js 24
- npm with lockfile v3 support
- A toolchain `better-sqlite3` can build against, when no prebuilt binary exists
  for your platform

## Get it running

```sh
npm ci
npm run build            # type-check and build the workspace graph
npm run build:server
npm run build:webclient
RECUED_WEBCLIENT_DIR="$PWD/apps/webclient/build" npm start
```

The server listens on `7717`. With the webclient built as above, open
<http://localhost:7717/webclient/>.

For a watched server process, `npm run dev` in place of `npm start`.

## The gate

```sh
npm run ci
```

That runs the build, both bundles, the test typecheck, and the test suite — the
same sequence used to qualify a source projection. Run it before opening a pull
request.

Individual pieces, when you want a faster loop:

```sh
npm test                                   # vitest, whole repo
npx vitest run path/to/file.test.ts        # one file
npm run typecheck:tests                    # tsc over tests, no emit
```

Two things worth knowing about the suite:

- Tests run on the `threads` pool. Most SQLite-backed tests isolate themselves
  with temp directories, but if you add one that does not, isolate it explicitly
  rather than relying on ordering.
- A full-suite run is a weak signal when you are attributing a failure. Run the
  failing file on its own before concluding what caused it.

## Changes that need extra care

- **`packages/` must not import `backend/`.** See ARCHITECTURE.md. This is
  enforced in review and by boundary tests.
- **Types belong in `packages/contracts/`.** If you find yourself redeclaring a
  shape, that is a signal the contract is missing one.
- **Copied vocabularies rot.** Derive a closed list from a single constant
  rather than restating its members; a subset still type-checks, and shipped
  JSON can silently fall outside a narrowed union.
- **Recipes are JSON.** Prefer expressing behaviour as a recipe over adding
  engine code. The authoring guides are at
  <https://recued.com/docs/guides/authoring-recipes/>.

## Style

Match the surrounding code — its naming, its idiom, and its comment density.
Comments here tend to explain *why* a thing is the way it is, especially where
the obvious approach was tried and rejected; that convention is worth keeping.

## Pull requests

Describe what changed and why, and say how you verified it. If a test does not
cover the change, say so plainly rather than describing the change as verified.
State any part you left incomplete.

## Reporting a security issue

Do not open a public issue. Email <support@recued.com> with what you found and
how to reproduce it, and we will route it.

## License

Recued is licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). Contributions are accepted under the same license.
