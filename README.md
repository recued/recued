# Recued

Recued holds the space between you and AI. An AI reads your world — mail,
calendar, files, contacts, CRM — through Recued and acts on it through Recued,
so your data and your accounts' credentials stay on machines you control, and
every action is granted in advance, gated at one enforcement boundary, audited,
and reversible. Any reasoning model connects over MCP.

This repository contains the self-hosted **server** and the **webclient**, plus
the workspace packages they are built from.

## Documentation

**<https://recued.com/docs>** — installing, pairing, connections, authoring
recipes and packs, publishing, AI chat and MCP, and the schema reference.

In this repository:

- [INSTALL.md](./INSTALL.md) — building and running from a clone
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the codebase is organised
- [CONTRIBUTING.md](./CONTRIBUTING.md) — build, test, and pull requests

## Quick start

```sh
npm ci
npm run build
npm run build:server
npm run build:webclient
RECUED_WEBCLIENT_DIR="$PWD/apps/webclient/build" npm start
```

The server listens on port `7717`. Open <http://localhost:7717/webclient/>.

Full detail, including platform prerequisites, is in [INSTALL.md](./INSTALL.md).

## What is in here

- `backend/server/` — the self-hosted Recued server and CLI
- `apps/webclient/` — the local webclient
- `packages/` — the workspace modules those two are built from
- `community/` — the Day-1 foundation packs and their recipes, as a worked
  example for the authoring guides

The root `package.json`, lockfile, and TypeScript build graph are generated for
this dependency closure. The browser bridge, the cloud services, the
marketplace, and Recued's internal tooling are separate concerns and are not
part of this repository.

The source payload is projected from a reviewed, committed checkpoint of the
Recued source tree; `.recued-public-export.json` records which one, what was
omitted, and why. Files such as this README, the install guide, the changelog,
and the contributor documentation are maintained here directly.

## License

Recued is licensed under the [GNU Affero General Public License, version 3
only](./LICENSE) (`AGPL-3.0-only`).
