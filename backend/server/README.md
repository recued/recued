# Recued Server

The Recued server runs your recipes: on a schedule, when something they watch changes, when you start one in the web app, or when an AI client calls one over MCP. It keeps your data and your accounts' credentials on this machine. The Recued web app and the Browser Bridge pair with it: the web app to show and control things, the Bridge to carry out steps that act on a web page.

Only the server runs recipes; the web app and the Bridge never do. HTTP, MCP, connection and AI steps run on the server, AI steps on the models you set up (see **AI models**). A step that acts on a web page (a DOM step) is sent to a paired Browser Bridge, and fails if none is connected.

## Install

| Where | How |
|---|---|
| **Linux, macOS** | `curl -fsSL https://recued.com/install.sh \| sh` |
| **Windows** (PowerShell) | `irm https://recued.com/install.ps1 \| iex` |
| **From source** | [Quick start (from source)](#quick-start-from-source) below |

The installers download the signed `recued` binary for this machine, check it against Recued's pinned release key, install it, and set it to start on its own: a LaunchAgent at login on macOS, a Startup shortcut on Windows, and on Linux a system service at boot when installed as root, or a user service when a desktop session is running. Set `RECUED_AUTOSTART=0` to skip that step. That binary updates itself; see **Update + migrate**.

[`config.sample.toml`](./config.sample.toml), beside this README, documents the common settings a `config.toml` can hold and where the server looks for that file.

`@recued/server` is not published to npm. Install it with an installer above, or from source.

After install, pair the web app:

```sh
recued pair            # prints a pairing code + an app.recued.com/pair link
# Open the link, which fills in the code, and enter your server's address there.
```

### `RECUED_IDENTITY_PASSPHRASE` — sealing the key file (D-212)

The server unwraps its vault key from a key file in the data directory at every boot. On first boot it seals that file with the first factor available: **`RECUED_IDENTITY_PASSPHRASE`** if set, otherwise a platform secret store (macOS login keychain / Windows DPAPI / the Linux Secret Service / systemd-creds) whose secret lives outside the data directory, otherwise **nothing**.

```sh
export RECUED_IDENTITY_PASSPHRASE='a long, random passphrase'
recued serve --db ./recued-data/recued.db
```

Or set **`RECUED_IDENTITY_PASSPHRASE_FILE`** to a file that holds it, such as a container secret under `/run/secrets/` or a systemd credential. The value then stays out of the environment. Set one or the other, not both. A named file that is missing, unreadable or empty stops the server instead of counting as "no passphrase". Inside a container no platform secret store exists, so a server there refuses its first boot without a passphrase rather than store the key file unsealed.

**Changing the passphrase later is cheap** — stop the server and run `recued rotate-passphrase`. It re-seals the same keyfile under a new passphrase: same realm, same data, same server identity, nothing re-pairs. Set the new value in the service environment before starting again.

**Changing the FACTOR is not.** Which factor seals the keyfile is recorded when the file is created and is permanent for that realm: before pairing the keyfile is disposable (stop, delete it, set or unset the variable, start again — costs a fresh identity, never data); after pairing it means `recued recover-keyfile` with the 24-word recovery key, which mints a new server identity, re-pairs every device, changes the publisher identity, and drops the account binding. Once sealed with a passphrase it is required at **every** start — the server fails loudly rather than opening the file without it.

Keep it in the service manager's secret mechanism (systemd `EnvironmentFile=`, a secret manager), not in `config.toml`: the server reads the passphrase only from these two variables. The web app shows how the key file is protected under **Settings → Server → Key Health**. (`recued auth-status` was retired in 26.10.8.)

The packaged systemd and launchd services both preserve the Phase C
exit-code contract so clean shutdowns stay down, restart/crash exits
respawn, and lock-held exits stop retry loops.

For inbound webhooks, you'll need a public hostname or tunnel. D-096 is load-bearing: Recued Cloud never relays webhooks. [Reachability](https://recued.com/docs/setup/reachability/) in the docs covers how to give the server a public name.

## Update + migrate (D-178)

### `recued update`

```sh
recued update            # check for a newer release (channel-independent)
recued update check      # explicit form of the default
recued update apply      # install it (server stopped)
recued update rollback   # go back to the previous release (server stopped)
```

`recued update` fetches the signed release manifest, verifies it, and
resolves it against this install locally — it works on every install,
because the *check* is universal. It prints the available version (if any)
plus how to apply it for your channel:

- **Installed with `install.sh` or `install.ps1`** (the binary channel): when
  the server runs under a service that restarts it, apply the update from the
  web app (**Settings → Updates**) and the server restarts itself. Otherwise,
  and always on Windows, stop the server and run `recued update apply`.
- **Built from source:** `recued update` tells you a newer release exists. It
  never replaces your build.

### `recued archive`

```sh
# Export everything (DB + config + blobs + vault-bundle) to one encrypted file:
recued archive export /mnt/usb/recued.archive --key-file=/path/to/recovery.txt

# Check an archive without restoring it (signature + manifest):
recued archive import /mnt/usb/recued.archive --key-file=/path/to/recovery.txt --dry-run

# Restore it (stop the server first):
recued archive import /mnt/usb/recued.archive --key-file=/path/to/recovery.txt

# Read the plaintext manifest (no key needed):
recued archive inspect /mnt/usb/recued.archive
```

The archive is encrypted with your recovery key. On the command line the key is its 32 bytes, written as 64 hex characters or in base64, from `--key`, `--key-file` or `RECUED_RECOVERY_KEY`. The web app's **Settings → Backup & Recovery** takes the 24 words instead. Per D-097, this is the ONLY cross-device migration path — Recued Cloud doesn't carry user data. Keep the archive somewhere safe (USB drive, NAS, cloud storage of your choice).

A restore refuses while the server is running unless you pass `--force`. It backs up the current database and tells you how to roll back, swaps the restored database into place, and then asks you to start the server again.

## Quick start (from source)

### Prerequisites

Node.js 24 and npm. The server keeps its data in SQLite through `better-sqlite3-multiple-ciphers`, a fork of `better-sqlite3` that can encrypt the database. There is no external database.

### Install

```bash
git clone https://github.com/recued/recued.git
cd recued
npm install
```

### Start

```bash
cd backend/server
npm start
```

The server starts on port 7717. Its database lives in your platform's standard place unless `--db` names another:

| Platform | Database |
|:---|:---|
| Linux | `~/.local/share/recued/recued-server.db` (under `$XDG_DATA_HOME` when that is set; `/var/lib/recued/recued-server.db` as root) |
| macOS | `~/Library/Application Support/recued/recued-server.db` |
| Windows | `%LOCALAPPDATA%\recued\recued-server.db` |

A pairing code is printed on first start.

### Pair the web app

1. Run `npx tsx src/bin.ts pair` (`recued pair` on an installed server). It prints a
   pairing code and an `app.recued.com/pair` link that fills in the code.
2. Open the link, or go to https://app.recued.com/pair and type the code. Enter the
   server's address there too, e.g. `http://localhost:7717`.

The web app trades the code for a client token of its own and keeps it. Each paired device gets its own token, which you can revoke under **Settings → Devices**. A pairing code works once and expires after 15 minutes; `--pair-code-ttl` or `RECUED_PAIR_CODE_TTL_MS` changes that.

### Run in the background

```bash
npx tsx src/bin.ts start          # start as daemon
npx tsx src/bin.ts status         # check running state
npx tsx src/bin.ts logs -f        # follow the log
npx tsx src/bin.ts stop           # stop the daemon
```

The daemon writes `recued-server.pid` and `recued-server.log` alongside the database file.
The log holds up to 5 MB, plus the previous 5 MB in `recued-server.log.1`. A server
started at login on macOS or Windows keeps its output there too. Under systemd it goes
to the journal instead (`journalctl -u recued`, or `journalctl --user -u recued`).

## CLI reference

`recued --help` prints:

```
recued <version> — your personal warehouse + 24/7 recipe runner

About:
  version, --version, -v              Print the version
  help, --help, -h                    Show this help

Daemon (background):
  start                               Start the server in the background
  stop                                Stop the background server
  restart                             Restart the background server
  status                              Show the running state

Server (foreground):
  (default), serve                    Start in the foreground
  --mcp --token <token>               Start an MCP stdio server. The token, or
                                      RECUED_MCP_TOKEN, comes from a contract on
                                      the web app's Contracts page; without one
                                      it offers no tools.

Pairing:
  pair                                Show a pairing code + the app.recued.com/pair link

Updates + backup:
  update [check]                      Check for a newer release
  update apply | rollback             Install it, or go back (server stopped)
  archive export <file>               Write an encrypted backup of this server
  archive import <file> [--dry-run]   Restore one (server stopped), or only check it
  archive inspect <file>              Print a backup's manifest

Diagnosis:
  doctor                              Explain why an install will not start or
                                      pair, or has stopped doing something

Recovery:
  recover-keyfile                     Re-create an unopenable server keyfile
                                      from your 24-word recovery key. Rescues
                                      the realm; mints a NEW identity, so every
                                      device must pair again.
  rotate-passphrase                   Change RECUED_IDENTITY_PASSPHRASE on an
                                      openable keyfile. Keeps the identity —
                                      nothing re-pairs. Server must be stopped.

Audit:
  audit                               List recent runs
  audit <run-id|recipe-id>            Show one run or filter by recipe
  audit activities                    List recent activity events
  audit export                        Export the full audit log as JSON
  audit clear                         Clear every audit entry

Logs:
  logs                                Print recent server log lines
  logs -f                             Follow the server log

Encryption:
  unlock                              Unlock a running server with its 24-word recovery key

LLM config:
  llm                                 Show the llm subcommand help
  llm show [--reveal-keys]            Print the current LLM config (keys redacted)
  llm set-slot <slot> ...             Configure slot_1 or slot_2
  llm set-budget <tokens>             Set the daily token budget (0 = unlimited)
  llm set-strategy <name>             Pool coordination: round_robin | weighted
  llm set-allow-upgrade <bool>        Global allow_llm_upgrade fallback
  llm list-pool-entries               List every free-pool entry
  llm add-pool-entry --type api ...
  llm remove-pool-entry --id <id>
  llm import <path> / export <path>   Round-trip the full config as JSON

Flags:
  --port <n>                          HTTP port (default: 7717)
  --db <path>                         SQLite path (default: recued-server.db
                                      in the platform's standard place)
  --reset-exposure                    One-shot recovery: discard persisted
                                      exposure state + restore the bootstrap-
                                      derived shape (/ws.lan true). Use after
                                      a lockout. Stamps a signed audit row
                                      with action exposure_reset_via_cli
                                      (Ed25519 over server_identity_key).
```

It also takes these flags, which `--help` leaves out:

| Flag | What it does |
|:---|:---|
| `--config <path>` | The `config.toml` to read |
| `--pair-code-ttl <duration>` | With `pair` or the server: how long a pairing code lasts, e.g. `30m`, `12h` or `7d` |

The CLI has no commands for recipes, packs, schedules or connections. You manage those in the web app, which uses the server's rpc methods (see **WebSocket rpc channel**), and AI clients reach recipes over MCP.

## Configuration

### Environment variables

The main ones:

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `7717` | HTTP listen port. `--port` wins over it, and it wins over `bind_port` in `config.toml` |
| `DB_PATH` | the platform's standard place (see **Start**) | SQLite database path. `--db` wins over it |
| `RECUED_CONFIG` | the platform's config folder | Path of `config.toml`. `--config` wins over it |
| `RECUED_IDENTITY_PASSPHRASE`, `RECUED_IDENTITY_PASSPHRASE_FILE` | -- | Seal the key file with a passphrase (see above) |
| `RECUED_MCP_TOKEN` | -- | Token for `recued --mcp` |
| `RECUED_RECOVERY_KEY` | -- | Recovery key for `recued archive` |
| `RECUED_PAIR_CODE_TTL_MS` | 15 minutes | How long a pairing code lasts |
| `RECUED_WEBHOOK_CLOCK_AUTHORITY_URL` | -- | Boot-pinned independent HTTPS time endpoint. It must return a fresh `Date` and exactly echo the request's `X-Recued-Clock-Nonce`; bounded cache-busting HEAD probes gate timestamped webhook profiles. Unset keeps them disabled. |
| `RECUED_VAULT_*` | -- | Vault entries (see **Credentials**) |
| `RECUED_LLM_PROVIDER` | -- | Slot 1 provider (`anthropic`, `openai`, `openai-compatible` or `google`) |
| `RECUED_LLM_MODEL` | -- | Slot 1 model name |
| `RECUED_LLM_API_KEY` | -- | Slot 1 API key |
| `RECUED_LLM_BASE_URL` | -- | Slot 1 base URL (optional, for proxies) |
| `RECUED_LLM_SLOT2_PROVIDER` | -- | Slot 2 provider |
| `RECUED_LLM_SLOT2_MODEL` | -- | Slot 2 model name |
| `RECUED_LLM_SLOT2_API_KEY` | -- | Slot 2 API key |
| `RECUED_LLM_SLOT2_BASE_URL` | -- | Slot 2 base URL (optional) |

### Credentials

Account credentials, such as API keys and OAuth tokens, are kept as **connections**, encrypted on this server. Add them on the web app's **Connections** page. A recipe names a connection and never sees its secret.

The older `vault` namespace is still read, from three places in this order of precedence: a `vault` object passed with a single `execute` call, `RECUED_VAULT_<key>` environment variables (the key is lower-cased and otherwise used as written), and an encrypted store. Nothing in the current CLI or web app writes that store, and no shipped ingredient uses the vault.

### AI models

AI steps run on the models you set up in the web app under **Settings → AI / Models**: free-tier entries first, then two BYOK slots, `slot_1` and `slot_2`. A step asks for a speed (`fast`, `quality` or `thinking`) and gets a model of that speed; `slot_1` is `fast` and `slot_2` is `quality` unless you set them otherwise. A step that names a slot skips the free tier.

For a headless server, slot 1 can come from the environment, and then wins over the stored slot 1:

```bash
export RECUED_LLM_PROVIDER=openai
export RECUED_LLM_MODEL=gpt-4.1-mini
export RECUED_LLM_API_KEY=sk-...
```

The `RECUED_LLM_SLOT2_*` variables set slot 2, but only when all three slot-1 variables are set.

### Daily token budget

Set a daily token budget under **Settings → AI / Models**, or with `recued llm set-budget <tokens>`. 0, the default, means no limit. AI calls from recipes, chat, the LLM gateway and housekeeping all count toward it, and the count resets at midnight UTC.

At 80% of the budget, the background pass that reads facts from your mail pauses. At 100%, recipe AI steps fail with `AI_TOKEN_BUDGET_EXCEEDED` until the reset. Chat, the LLM gateway and housekeeping keep counting but are not stopped. Each slot can also have a daily cap of its own, set on the same page.

## Architecture

### Workspace packages

The server is built from the workspace packages under `packages/`, bundled into its release. The ones at its core:

| Package | Use |
|:---|:---|
| `@recued/contracts` | Types, operators, namespaces, error codes, and the rpc registry |
| `@recued/engine` | Recipe execution (`executeRecipe`) and preflight |
| `@recued/ingredients` | Step adapters: HTTP, MCP, DOM, kernel and connection |
| `@recued/llm` | Model routing across the free tier and BYOK slots |
| `@recued/recipes` | Recipe validation, parsing |
| `@recued/scheduler` | Cron matching and schedule types |
| `@recued/storage` | Stores: the encrypted vault, collections, connections, config and the audit log |

### Source layout

```
backend/server/src/
  bin.ts                  CLI entry point; routes each command
  commands/, cli/, cli-context/   The CLI commands
  serve/, composition/    Boot: builds and wires the running server
  server.ts               HTTP path routing (see HTTP endpoints)
  ws-server.ts            The /ws rpc channel and what it pushes
  rpc-dispatcher.ts       Routes rpc calls to their handlers
  mcp-server.ts           MCP over stdio (MCP over HTTP is in ports/mcp/)
  ports/                  HTTP surfaces: MCP, LLM gateway, webhooks, reception
  execute-handler.ts      Runs a recipe, for the execute rpc, schedules, MCP and triggers
  scheduler.ts            The cron tick
  schedule-handler.ts     The schedules.* rpc methods
  auto-run-scheduler.ts   Recipes set to run on their own
  triggers/               Event triggers
  bridges/                Browser Bridge commands and the DOM adapter
  collections/            Mail, calendar, file and webhook collections
  mail-facts/             Facts read from email
  housekeeping/           Idle-time maintenance
  storage/                SQLite stores
  keys/, key-manager.ts, open-database.ts   Keys, and encryption at rest
  pairing.ts              Pairing codes
  server-vault.ts         The encrypted vault store
  llm-config.ts           AI slots, free tier and budget
  update/                 Self-update
```

### Ingredient kinds

| Kind | Where it runs |
|:---|:---|
| `http` | On the server |
| `mcp` | On the server, as JSON-RPC over HTTP |
| `ai` | On the server, on your configured models (see **AI models**) |
| `connection` | On the server, through a named connection: an API, an MCP server or a notification channel |
| `cli` | On the server: a pack operation that runs a local program |
| `storage`, `service` | On the server: Recued's own kernel ingredients |
| `dom` | Sent to a paired Browser Bridge; fails if none is connected |
| `chat` | Not supported. The web-chat ingredients were retired |

## MCP integration

The server speaks MCP (Model Context Protocol) two ways: over stdio, as a separate `recued --mcp` process that opens the server's database itself, and over HTTP at `/mcp` on the running server (see **HTTP endpoints**). Either way the AI client needs a token. Create a contract on the web app's **Contracts** page: it shows the token once, and it decides which tools that token may call. The page also gives ready-made settings for MCP clients that connect over HTTP.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`, with the full path to `recued` (`command -v recued` prints it):

```json
{
  "mcpServers": {
    "recued": {
      "command": "/full/path/to/recued",
      "args": ["--mcp", "--token", "<token from the Contracts page>"]
    }
  }
}
```

Running from source, use `"command": "npx"` and `"args": ["tsx", "/path/to/recued/backend/server/src/bin.ts", "--mcp", "--token", "<token>"]`. If the key file is sealed with a passphrase, the MCP process needs it too: add `RECUED_IDENTITY_PASSPHRASE_FILE` (or `RECUED_IDENTITY_PASSPHRASE`) under `"env"`.

### Cursor

Add the same `recued` entry to `.cursor/mcp.json`.

### MCP tools

The tool list is built for each request and holds only what the token's contract grants:

- the core tools in `MCP_TOOL_CATALOG` (`packages/contracts/src/mcp-tool-catalog.ts`), such as `recued_listRecipes`, `recued_runRecipe`, `recued_getAudit` and `recued_dataTimeline`;
- a `recued_ingredient_<slug>` tool for each exposed ingredient;
- recipes and data operations from the registry;
- the operations of installed packs and configured connections.

Over stdio the server speaks newline-delimited JSON-RPC 2.0. `initialize` answers with protocol version `2024-11-05`; the server also implements the `2026-07-28` revision and its `server/discover` method.

## WebSocket rpc channel

Paired clients talk to the server over one WebSocket at `/ws`, for example `ws://localhost:7717/ws`. The client token from pairing is checked before the connection is accepted; **HTTP endpoints** lists the three ways to send it.

Each call is an rpc envelope:

```
→ { "type": "rpc", "request_id": "…", "method": "recipe.list", "args": { … } }
← { "type": "rpc_result", "request_id": "…", "result": … }
← { "type": "rpc_result", "request_id": "…", "error": { "code": "…", "message": "…" } }
```

The methods, with their argument and result types, are `ServerRpcRegistry` in `packages/contracts/src/rpc/server-registry.ts`. A socket may have 64 calls in flight, and the server 256 in all; past that a call fails with `rpc_overloaded`. Until a recovery key is enrolled, only a few methods work and the rest fail with `server_not_enrolled`.

The server also pushes:

| Message | When |
|:---|:---|
| `server_event` | A broadcast event of a kind the client named in `events.subscribe` |
| `approval_changed` | An approval changed, once the client has called `approval.subscribe` |
| `server_heartbeat` | Every 5 seconds |
| `ws_lockout` | Just before the server closes the socket with code 4004 |
| `instance_revoked` | This device was revoked; the server closes the socket with code 4003 |

A Browser Bridge also receives page commands as `{ "kind": "command", "command": … }` and answers with `{ "kind": "result", "result": … }`. Files move over sockets of their own: `/ws/upload`, `/ws/download` and `/ws/archive-upload`.

## Scheduling

The scheduler looks for due schedules every 60 seconds, and once at start. A recurring schedule is a 5-field cron expression, read in the schedule's time zone or, if it has none, the server's. It fires at most once a minute, and not while its previous run is still going. A one-off schedule fires at its time. When the server was off at a scheduled time, the schedule's missed-run policy decides what happens: `catch_up`, `skip`, `auto` (the default) or `ask`.

Every run happens on this server, through the same path as a run started from the web app. A schedule records its last status (`success`, `error` or `skipped`), its last error and how many times in a row it has failed. It is skipped, and stays armed, while its dish is switched off or its pack is not installed. The owner is told when a schedule starts failing, and after 5 failures in a row it is switched off. Manage schedules in the web app, or with the `schedules.*` rpc methods.

## HTTP endpoints

Most of the server is not plain HTTP. Running recipes, schedules, connections, the audit log and settings all go through rpc methods on the `/ws` WebSocket; the full list is `ServerRpcRegistry` in `packages/contracts/src/rpc/server-registry.ts`. The paths below are the only ones the server answers over HTTP. Any other path gets a 404.

| Path | Method | Purpose | Credential |
|:---|:---|:---|:---|
| `/health` | `GET` | Liveness check: `{ "status": "ok", "now": <epoch_ms> }` | None |
| `/ws` | WebSocket upgrade | The rpc channel and live events | A client token, as `Authorization: Bearer <token>` or, from a browser, in the `Sec-WebSocket-Protocol` header. A `?token=` query is still accepted from older clients. |
| `/auth/pair` | `POST` | Exchanges a pairing code or the recovery key for a client token. The first pairing on a server needs a code. | None. The code or key in the body is the credential. |
| `/auth/identity-probe` | `POST` | Lets a client confirm that the server at an address is the one it already trusts, before sending it a token | None |
| `/status`, `/status.json` | `GET` | Recipes that were disabled automatically, as HTML or JSON | The realm token, as `Authorization: Bearer` |
| `/mcp` | `POST` | MCP over HTTP (JSON-RPC 2.0). `GET` opens the older SSE transport. | `Authorization: Bearer` with a paired CLI client's token or an inbound token (`recued_...`) |
| `/mcp/catalog` | `GET` | The tools that token may call | Same as `/mcp` |
| `/v1/models`, `/v1/chat/completions` | `GET`, `POST` | OpenAI-compatible chat gateway, also served under `/llm-gateway/`. Only when configured. | `Authorization: Bearer` with an inbound token (`recued_...`) |
| `/webhooks/<vendor>/<connection>` | `POST` | Bot callbacks from chat apps such as Slack and Telegram. `GET` answers only a vendor's ownership handshake. | The vendor's signature |
| `/v1/connection/webhook/<vendor>/<connection>` | `POST` | Change events pushed by a CRM such as HubSpot or Salesforce. Only when the server is publicly reachable. | The vendor's signature |
| `/v1/webhooks/<id>` | Set by the profile | Vendor deliveries for packs and recipes, addressed by an opaque id. Only while webhook profiles are running. | Checked by the profile |
| `/reception/...` | `GET`, `POST`, `DELETE` | Visitor pages: forms, bookings and file drops | The endpoint's token, as `?t=`, `X-Recued-Endpoint-Token` or `Authorization: Bearer` depending on the kind |
| `/oauth/complete` | `GET`, `POST` | Finishes an OAuth sign-in this server started. Only when configured. | The signed state of a pending sign-in |
| `/ask/<ask_id>` | `GET`, `POST` | A page for answering a question the server emailed to the owner. Only when configured. | The unguessable id. A `POST` also needs a single-use form nonce. |
| `/webclient/` | `GET` | The web app bundled with the server, when a verified bundle is present | None to load it. Pairing happens in the app. |
| `/` | `GET` | On the LAN, redirects to `/webclient/` when the web app is bundled. On the public listener, redirects to `https://app.recued.com/` by default. | None |

The server can serve each group of paths on its LAN listener, its public TLS listener, both or neither. Three presets set them all at once: `lan_only`, `public` and `maintenance`, which serves nothing. MCP is never served publicly without a separate acknowledgement, and no preset makes the bundled web app public. The groups are `PATH_FOR_ROLE` and the presets `EXPOSURE_PRESET_PATH_MAP`, both in `packages/contracts/src/network.ts`. Older paths such as `/auth/pair` and `/v1/chat/completions` are mapped to their groups in `SERVER_LEGACY_PATH_ALIASES` in `src/server.ts`.

## Development

```bash
npm run dev       # start with auto-reload (tsx --watch)
npm run build     # bundle the server into dist/ (scripts/build.mjs)
npm test          # vitest run
```

### Testing

Tests use `vitest`. Many open real SQLite databases, mostly in memory (`:memory:`), so the native SQLite module must be built. Tests that need a listening server bind a random port (`port: 0`).

### Dependencies

- `better-sqlite3-multiple-ciphers` -- SQLite driver that can encrypt the database (embedded, no external DB)
- `ws` -- the `/ws` rpc channel and the file sockets
- `imapflow`, `nodemailer` -- reading and sending mail
- Workspace packages from `packages/`, bundled at build time

## Security

- **Client tokens.** Pairing gives each device its own token. The server keeps only an Argon2id hash of it, and you can revoke a device under **Settings → Devices**. Treat a token like a password.
- **MCP tokens** (`recued_...`) come from a contract and can call only the tools that contract grants.
- **The realm token** now opens only `/status`.
- **The recovery key** (24 words) unlocks the server, re-creates a lost key file and decrypts archives. Keep it offline.
- **Encryption at rest.** Connection credentials and the vault (AES-256-GCM) are encrypted under keys derived from the server's master key, which the key file unwraps at start. Once the server is enrolled, at its first pairing, the database file is encrypted too.
- **Pairing codes** are single-use, 8 alphanumeric characters, and expire after 15 minutes. The server prints one when it first starts, and `recued pair` prints a new one.
- **Your accounts' data** is fetched by this server directly, with the credentials stored here. It never goes through Recued Cloud.
