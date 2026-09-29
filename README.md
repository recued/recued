[Demo](https://demo.recued.com) | [Documentation](https://recued.com/docs) | [Marketplace](https://recued.com/packs)

# Recued

Recued holds the space between you and AI. Recued is where your work really
lives: the records, the routines, the decisions. People and AI both take part
in it. Each one is an actor whose powers were declared ahead of time. So
neither one runs the other. And every action crosses a line you drew in advance.

This repo holds the complete self-hosted **server** and the **webclient**. It
also holds the workspace packages they are built from.

## What Recued is not

- Not a coding agent.
- Not a general chat app.
- Not a runner for `SKILL.md` files. Recued cannot run them.
- Not built for open-ended questions that take many steps over a long stretch.

## What Recued is

- One server, one owner. Each Recued server stands on its own. It stands for
  one person or one organization (a company, a team, a family, and so on).
- It connects to any provider and any API. It makes your command-line tools
  reachable too.
- Any AI agent can connect over MCP: Codex, Claude, OpenClaw and the other
  Claw variants, or your own.
- It keeps a local copy of your mail, contacts, and CRM records. So reads are
  fast.
- Before an AI sees any of your warehouse data, it tries to swap out the
  personal bits. Those are names, emails, organizations, phone numbers, and
  addresses. Safe stand-ins go in their place. This is the PII alias. It does its best, it is safe, and it can be undone. The stand-ins still show
  the region (city, state, country). They still show which people and sites
  belong to the same organization. So the model can reason over that.
- It encrypts your data at rest (while it sits on disk). The 24-word recovery
  key is the only way back in.
- No third party sits in the middle. Nobody takes a cut of your money. Nobody
  pipes your data.
- It works with any AI provider, hosted or local. You get two default slots,
  plus an unlimited pool of extra provider slots it rotates through.
- Every risky action can be gated. Then it runs only after you say yes.
- Free to run. No feature is locked away.

## Install

One command. It fetches the signed binary for your platform. That is the
program file, stamped so you know it is really from Recued. It checks it
against the release key. It puts `recued` on your PATH, so you can run it from
anywhere. And it sets it to start when you log in.

```sh
# Linux and macOS
curl -fsSL https://recued.com/install.sh | sh
```

```powershell
# Windows — in PowerShell
irm https://recued.com/install.ps1 | iex
```

The installer starts the server too. So when it is done, the server is
already running. To pair a browser, run `recued pair`. It prints a pairing
code and a link to the webclient. Open the link and type in the code. If
`recued` is not found in that terminal, open a new one.

Do not want it to start at login? Put `RECUED_AUTOSTART=0` in front of the
command. Then start it yourself with `recued serve`. It prints the pairing
code. The install location, the release channel, and the rest are in
[INSTALL.md](./INSTALL.md#options).

A **headless Linux** box is one with no screen or desktop. There, starting at
boot needs root, the admin account. Run the installer with `sudo`, and pair
with `sudo` too. The installer prints the exact command. Here is why. Without a desktop keyring, there is only one way to
seal the key file to the machine. That way reads a host key only root can
read. A Linux desktop session installs a user unit and needs no root.

## Pack

A pack is a JSON file. It says how to connect to any resource: a CLI, a SaaS,
a REST API, or MCP. You can set permissions for each operation. By default,
every write, admin, and destructive action needs your approval by hand.
Ready-made packs are free at https://recued.com/packs. You can make your own
with the built-in editor, or in JSON.

## `SKILL.md` and recipes

A skill tells a model how to approach something. The model decides each step
as it runs. A recipe is the steps themselves. It is JSON, fixed before the
run. The server runs it. It calls a model only where judgment is really
needed.

They are not rivals. Recued offers recipes over MCP. So the skill that
decides *this morning is worth looking at* can hand the work to a recipe. The
only question is which half of a job belongs in which.

### A worked example

Every Monday morning: pull the past week's rising search terms from Google
Trends. Then work out whether there is anything worth selling against them.

The hard step is the first one, and it is not a lookup. Trending searches name
people, teams, and events: `bmw championship payout`, `chapecoense vs são
paulo`, `hurricanes weather`. None of those is a product. A golf tournament
means gloves and rangefinders. A storm means battery lanterns. And plenty of
terms warrant nothing at all. Deciding that is judgement. It is the one part
of this job a model has to do. What follows is plain math. Ask the catalogue
what each keyword sells. Look up what those clicks cost to bid on. Subtract.
Rank.

As a recipe, that is thirty-six steps. Two of them call a model. One call
turns trending terms into product keywords. One call writes the buying brief.
Everything in between always gives the same answer for the same input. That
kind of work needs no context window (the model's working memory). The 619KB
export, the 110 catalogue fetches, and the 1,249 product rows they return
never enter one. Both model calls are a fixed size by design. So the input
side stays near 3,000 tokens, whether the model picks 32 keywords or 58.
Tokens are the small pieces of text a model counts. Point it at a 6MB
export and a 10,000-product catalogue, and that figure does not move.

The same job as a skill is not a strawman, a weak version set up to lose. The
strongest version does not read
the export at all. Give the agent a shell, and it fetches straight to disk. It
parses with a bundled script. So those bytes never enter a context window, and
they cost nothing to receive. But look at what it has become: a program with a
natural-language wrapper. It needs its own secret keys, retries, and rate
limits. It needs a place to keep the file. And it needs a way to run on
Tuesday, when nobody opens a session. A recipe is that program, on a server
that already has all of those.

The full write-up is in **[`examples/`](./examples/README.md)**. It has the
recipe itself. It has the skill it is measured against, written blind. It says
what is real here and what is mocked. And it tells what happened when one
sentence of that prompt was wrong.

## What you can run on Recued, for your life and business

- Take bookings, appointments, big file drops, and custom intake forms through
  a public reception page.
- Answer questions about your products with AI. The answers stay grounded in
  the knowledge and Q&A you import.
- Sell through Stripe.
- Charge by subscription or by use for the MCP tools you publish.
- Charge by subscription or by use for the knowledge you serve through the LLM
  gateway.
- Prototype fast. Turn an idea into a working app.
- Extend Recued about as far as you like. Write your own packs and recipes, or
  install free ones from the [Recued Marketplace](https://recued.com/packs).

## Examples, concretely

I built some real business apps to show what Recued can do:

- [Ledger Book](https://recued.com/packs/ledger-book): accounting, double
  entry, budgets, and records.
- [Fleet Money](https://recued.com/packs/fleet-money): assigned jobs and
  worker payments, from offer through settlement.
- [Queue Desk](https://recued.com/packs/queue-desk): a take-a-number line. A
  visitor picks a service type on your public reception form. They get a
  number and a link that shows how many people are still ahead. Staff call the
  next person from any paired device.
- [DeepTutor Records](https://recued.com/packs/deeptutor-records): a
  subscription business in education and tutoring. It keeps students,
  assessments, answers, artifacts, and scorecards. It comes with nine
  ready-to-run workflows that enrol students, send assessments, capture
  answers, and grade them. It needs the DeepTutor pack to make questions.
  It runs on your own machine. Actions that change data use Recued's
  approval controls. [DeepTutor](https://github.com/HKUDS/DeepTutor) is an
  open source project by HKUDS.
- [Rental Book](https://recued.com/packs/rental-book): property, landlord,
  ledger, and records.
- [Federated Projects](https://recued.com/packs/federated-projects): project
  management, federation, records, and work entities. It shows a few Recued
  servers joining up to work together, through
  [Federated Project Peer](https://recued.com/packs/federated-project-peer).
- [Social Publishing](https://recued.com/packs/social-publishing): scheduling
  posts to Mastodon, X, Facebook, and Bluesky.

## Documentation

**<https://recued.com/docs>** covers how to install, pair, and connect. It
also covers writing recipes and packs, publishing, AI chat and MCP, and the
schema reference.

In this repo:

- [INSTALL.md](./INSTALL.md): how to install a release, its options, and how
  to build from a clone
- [ARCHITECTURE.md](./ARCHITECTURE.md): how the code is laid out
- [CONTRIBUTING.md](./CONTRIBUTING.md): build, test, and pull requests

## Run from source

```sh
npm ci
npm run build
npm run build:server
npm run build:webclient
RECUED_WEBCLIENT_DIR="$PWD/apps/webclient/build" npm start
```

The server listens on port `7717`. Open <http://localhost:7717/webclient/>.
You can also use the stable static webclient at <https://app.recued.com/>.

Full detail, including what each platform needs first, is in
[INSTALL.md](./INSTALL.md).

## What is in here

- `backend/server/`: the self-hosted Recued server and CLI
- `apps/webclient/`: the local webclient
- `packages/`: the workspace modules those two are built from
- `community/`: the Day-1 foundation packs and their recipes, as a worked
  example for the authoring guides

The root `package.json`, the lockfile, and the TypeScript build graph are
generated by a tool, not by hand. They cover exactly the set of packages this
repo depends on. The browser bridge, the cloud services, the marketplace, and
Recued's own in-house tools are separate things. They are not part of this
repo.

The source code is a filtered copy of one reviewed checkpoint of the Recued
source tree. That checkpoint is a git commit. The file
`.recued-public-export.json` records which one, what was left out, and why.
This README, the install guide, the changelog, and the contributor notes are
kept here directly.

## License

Recued is licensed under the [GNU Affero General Public License, version 3
only](./LICENSE) (`AGPL-3.0-only`).
