# Architecture

Orientation for people working on this codebase. For using Recued, installing a
server, or authoring recipes and packs, read <https://recued.com/docs>.

## The shape of the system

Recued holds the space between you and an AI. The AI reads your world through
Recued and acts on it through Recued, so your data and your accounts'
credentials stay on machines you control, and every action is granted in
advance, gated at one enforcement boundary, audited, and reversible.

There are four surfaces. **Two of them are in this repository.**

| Surface | Role | Here? |
|:--|:--|:--|
| **Server** (`backend/server/`) | Sole orchestrator. Runs every recipe, holds the warehouse and credentials, is the identity root and audit authority, hosts MCP. | ✅ |
| **Webclient** (`apps/webclient/`) | Thin PWA: display and input. No engine code. Pairs directly to a server you run. | ✅ |
| **Browser Bridge** | Narrow DOM executor and OS notification surface. Runs only signed commands the server hands it. | ✗ |
| **Cloud** | Naming (DDNS), certificates (ACME), marketplace, accounts. Routes none of your traffic and decrypts nothing. | ✗ |

The two absent surfaces are separate concerns and are not required to build,
run, or develop the server and webclient.

## Repository layout

```
backend/server/     the self-hosted server and CLI — an entry point
apps/webclient/     the local webclient — an entry point
packages/           31 workspace modules the two entry points depend on
community/          the Day-1 foundation packs and their recipes (see below)
test/               shared test helpers
```

34 npm workspaces in total. The root `package.json`, the lockfile, and the
TypeScript build graph are generated for exactly this dependency closure — they
are not the private repository's files with parts removed.

### The one rule that is not negotiable

**Nothing in `packages/` may import from `backend/`.**

`packages/` is portable engine code: contracts, the recipe engine, transforms,
storage, the gateway, crypto, the renderer. `backend/server/` is one runtime
that consumes it. Reversing that edge would weld the engine to a single host and
is rejected in review.

Within `packages/`, `contracts` is the source of truth for types, operators,
namespaces, and error codes. Everything else imports from it. If a type you need
does not exist there, that is a gap to raise rather than route around.

## How a recipe runs

Recipes are JSON, not code — compositions of ingredients over a small set of
transforms. The engine in `packages/engine/` resolves references, evaluates
conditions, and runs steps; `backend/server/` supplies the IO, the storage, and
the enforcement.

Execution is server-side. Clients render or actuate; they never run the engine.
Recipes reach data through namespaces (`config`, `step`, `data.*`, `connection`,
…) and the resolver is null-safe end to end, so a missing namespace, collection,
or record all surface the same way.

Credentials never reach a recipe. A recipe names a connection; only the kernel
connection adapter decrypts, at call time.

## `community/`

This repository carries the **foundation** packs — the five `pre_install` pack
manifests and the thirteen recipes they reference. That is the same content
compiled into `backend/server/src/bundled-foundation.generated.ts` and shipped
inside the binary, so a server started from a clone and a server installed from
a release pre-install the same Day-1 content.

It is a worked example: real manifests and real recipes to read, fork, and test
against while following the authoring guides. The wider marketplace catalog is
distributed through the marketplace, not through this repository.

## Building and testing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Reading further

The concept documentation — how execution, grants, approvals, the warehouse, and
audit fit together — lives at <https://recued.com/docs>:

- <https://recued.com/docs/concepts/how-recued-works/>
- <https://recued.com/docs/concepts/grants-and-approvals/>
- <https://recued.com/docs/concepts/warehouse/>
- <https://recued.com/docs/reference/recipe-schema/>

Source comments reference decisions by number (`D-145`, `D-192`, …). Those are
internal design records and are not published; the surrounding comment is
written to stand on its own, and the number is there so a maintainer can trace
provenance.
