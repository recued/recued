[Demo](https://demo.recued.com) | [Documentation](https://recued.com/docs) | [Marketplace](https://recued.com/packs)

# Recued

Recued holds the space between you and AI. Recued is where your work actually
lives — the records, the routines, the decisions. People and AI both take part
in it as actors with declared authority, so neither one operates the other, and
every action crosses a boundary you set in advance.

This repository contains the self-hosted **server** and the **webclient**, plus
the workspace packages they are built from.

## What Recued is not

- Not a coding agent.
- Not a generic chat client.
- Not a runner for `SKILL.md` — Recued cannot execute them.
- Not built for long-horizon, open-ended questions.

## What Recued is

- One server, one owner. Each Recued server is sovereign, standing for a single
  person or entity.
- Connects to any provider and any API, and makes your CLI tools reachable.
- Open to any AI agent over MCP — Codex, Claude, OpenClaw and the other Claw
  variants, or your own.
- Mirrors mail, contacts, and CRM records locally, so reads are fast.
- Encrypts your data at rest; the 24-word recovery key is the only way back in.
- No third party in the middle, taking a cut of your revenue or piping your
  data.
- Works with any AI provider, hosted or local.
- Free to run, with no feature gates.

## What you can run on it, for your life and business

- Take bookings, appointments, large file drops, and custom intake forms through
  a public reception page.
- Answer questions about your products with AI, grounded in knowledge and Q&A
  you import.
- Sell through Stripe.
- Charge subscription or usage for the MCP tools you publish.
- Charge subscription or usage for the knowledge you serve through the LLM
  gateway.
- Prototype quickly — turn an idea into a working app.
- Extend Recued about as far as you like by writing your own packs and
  recipes, or installing free ones from the
  [Recued Marketplace](https://recued.com/packs).

## Examples, concretely

I built some real business apps to illustrate what Recued can do:

- [Ledger Book](https://recued.com/packs/ledger-book) — accounting, double
  entry, budgets, and records.
- [Fleet Money](https://recued.com/packs/fleet-money) — assigned jobs and
  worker payments, from offer through settlement.
- [Queue Desk](https://recued.com/packs/queue-desk) — a take-a-number line. A
  visitor picks a service type on your public reception form and gets a number
  plus a link showing how many are still ahead; staff call the next person from
  any paired device.
- [DeepTutor Records](https://recued.com/packs/deeptutor-records) — a
  subscription business in education and tutoring: students, assessments,
  answers, artifacts, and scorecards, with nine ready-to-run workflows that
  enrol students, send assessments, capture answers, and grade them. It needs
  the DeepTutor pack for question generation. It runs locally on your machine,
  and actions that change data use Recued's approval controls.
  [DeepTutor](https://github.com/HKUDS/DeepTutor) is an open source project
  developed by HKUDS.
- [Rental Book](https://recued.com/packs/rental-book) — property, landlord,
  ledger, and records.
- [Federated Projects](https://recued.com/packs/federated-projects) — project
  management, federation, records, and work entities. It shows several Recued
  servers joining up to collaborate, through
  [Federated Project Peer](https://recued.com/packs/federated-project-peer).
- [Social Publishing](https://recued.com/packs/social-publishing) — scheduling
  posts to Mastodon, X, Facebook, and Bluesky.

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
You may also use the stable static webclient at <https://app.recued.com/>.

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
