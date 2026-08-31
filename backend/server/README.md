# Recued Server

Headless recipe engine that runs outside the browser. Executes recipes on a schedule, exposes them as MCP tools for AI agents (Claude Desktop, Cursor), and pairs with the Recued webclient and Browser Bridge for display, DOM actuation and AI delegation.

The server reuses the same packages the clients use (`@recued/engine`, `@recued/ingredients`, `@recued/llm`, `@recued/contracts`) so recipe behavior is identical. HTTP and MCP ingredients run natively. LLM ingredients run when BYOK API keys are configured. DOM and chat ingredients delegate to a connected Browser Bridge via WebSocket.

## Install

Pick the install path that matches your setup. All four deliver the same `recued` binary + `config.sample.toml`.

| Distribution | Best for | Command |
|---|---|---|
| **npm** | Developers + VPS operators already running Node | `npm install -g @recued/server` |
| **Docker** | Container-first hosts, Docker Compose stacks, Fly.io | `docker run -v recued-data:/var/lib/recued recued/server:26.8.31` |
| **Homebrew** | macOS desktop + headless Mac | `brew install recued/tap/recued-server` |
| **cloud-init** | Advanced unattended provisioning on DigitalOcean / Hetzner / Linode | paste [`distribution/vps/cloud-init.yml`](../../distribution/vps/cloud-init.yml) into user-data |

After install, pair the webclient:

```sh
recued pair            # prints a pairing code + an app.recued.com/pair link
# Open that link to complete pairing.
```

See [`distribution/homebrew/README.md`](../../distribution/homebrew/README.md) for Homebrew service management and [`distribution/vps/README.md`](../../distribution/vps/README.md) for provider-specific cloud-init details. The Docker variant's compose file is at [`docker-compose.yml`](./docker-compose.yml) — `docker compose up -d` with a mounted `config.toml` works out of the box.

### `RECUED_IDENTITY_PASSPHRASE` — sealing the key file (D-212)

The server unwraps its vault key from a key file in the data directory at every boot. On first boot it seals that file with the first factor available: **`RECUED_IDENTITY_PASSPHRASE`** if set, otherwise a platform secret store (macOS login keychain / Windows DPAPI / systemd-creds) whose secret lives outside the data directory, otherwise **nothing**.

⚠ **Containers land in the unsealed case.** A host credential key is either on the ephemeral layer (`--force-recreate` destroys the realm's only key) or inside the data volume (it travels with a copy), so the platform rung declines by design. Unsealed still encrypts the realm — what it stops defending is capture of the whole data directory, which then carries the key too.

```sh
export RECUED_IDENTITY_PASSPHRASE='a long, random passphrase'
recued serve --db ./recued-data/recued.db
```

**Changing the passphrase later is cheap** — stop the server and run `recued rotate-passphrase`. It re-seals the same keyfile under a new passphrase: same realm, same data, same server identity, nothing re-pairs. Set the new value in the service environment before starting again.

**Changing the FACTOR is not.** Which factor seals the keyfile is recorded when the file is created and is permanent for that realm: before pairing the keyfile is disposable (stop, delete it, set or unset the variable, start again — costs a fresh identity, never data); after pairing it means `recued recover-keyfile` with the 24-word recovery key, which mints a new server identity, re-pairs every device, changes the publisher identity, and drops the account binding. Once sealed with a passphrase it is required at **every** start — the server fails loudly rather than opening the file without it.

Keep it in the service manager's secret mechanism (systemd `EnvironmentFile=`, compose `env_file`, a secret manager), not in `config.toml` — that file lives in the directory the passphrase protects. `recued auth-status` prints the current posture.

The packaged systemd, launchd, Docker, Homebrew, and VPS service
surfaces all preserve the Phase C exit-code contract so clean shutdowns
stay down, restart/crash exits respawn, and lock-held exits stop retry loops.

For inbound webhooks (`data.webhook.*`), you'll need a public hostname or tunnel. D-096 is load-bearing: Recued Cloud never relays webhooks. The [`distribution/vps/cloud-init-with-caddy.yml`](../../distribution/vps/cloud-init-with-caddy.yml) template wires Caddy + Let's Encrypt for the self-host path.

## Update + migrate (D-178)

### `recued update`

```sh
recued update          # check for a newer release (channel-independent)
recued update check    # explicit form of the default
```

`recued update` fetches the signed release manifest, verifies it, and
resolves it against this install locally — it works on every install
(binary, Docker, Homebrew, source) because the *check* is universal.
It prints the available version (if any) plus how to apply it for your
channel. Applying is channel-specific:
Docker users upgrade via `docker pull recued/server:<tag>`; Homebrew
users via `brew upgrade recued-server`; on the self-updating binary channel the
running server stages + restarts from the webclient (Settings →
Updates). `recued update apply` is not a CLI action — it mutates the
live binary and restarts the daemon, so it runs on the server itself.

### `recued archive`

```sh
# Export everything (DB + config + blobs + vault-bundle) to one file:
recued archive export /mnt/usb/recued.archive --key-file=/path/to/recovery.txt

# Dry-run an import — verify signature + manifest without writing:
recued archive import /mnt/usb/recued.archive --key-file=/path/to/recovery.txt --dry-run

# Peek at the plaintext manifest (no decryption):
recued archive inspect /mnt/usb/recued.archive
```

The archive is encrypted with your FileVault recovery key (the same 24-word recovery key). Per D-097, this is the ONLY cross-device migration path — Recued Cloud doesn't carry user data. Keep the archive somewhere safe (USB drive, NAS, cloud storage of your choice); the recovery key decrypts it.

CLI restore flow remains verify-first: stop the server, decrypt + extract the archive into `data_path`, restart. `archive import --dry-run` verifies the archive is intact + the current server can read it before you commit to the restore. The Phase G `server.archive.*` RPC handler is the UI/runtime surface for host-wired restores; the package CLI still does not swap `data_path` in place.

## Quick start (from source)

### Prerequisites

Node.js 20+ and npm. The server uses SQLite via `better-sqlite3` -- no external database.

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

The server starts on port 7717 with a SQLite database at `./recued-server.db`. A pairing code is printed on first start.

### Pair the webclient

1. Run `recued pair` — it prints a pairing code and an `app.recued.com/pair` deeplink
   carrying that code
2. Open the deeplink (or go to https://app.recued.com/pair and enter the code plus
   the server URL, e.g. `http://localhost:7717`)

The webclient exchanges the pairing code for a long-lived realm token and stores it. All subsequent requests use the token. The pairing code expires after 15 minutes and is single-use.

### Run in the background

```bash
npx tsx src/bin.ts start          # start as daemon
npx tsx src/bin.ts status         # check running state
npx tsx src/bin.ts logs -f        # follow the log
npx tsx src/bin.ts stop           # stop the daemon
```

The daemon writes `recued-server.pid` and `recued-server.log` alongside the database file.

## CLI reference

```
recued -- headless recipe engine

Daemon:
  start                               Start server in background
  stop                                Stop background server
  restart                             Restart background server
  status                              Show running state

Server:
  (default)                           Start in foreground
  --mcp                               Start MCP stdio server

Recipes:
  run <recipe-id>                     Run a recipe
  export <recipe-id>                  Export recipe bundle (JSON)
  import <file.json>                  Import recipe or bundle
  install <slug-or-url>               Install from marketplace
  import-bundle <bundle.json>         Import a SyncBundle
  update [recipe-id]                  Update marketplace recipes
  list                                List recipes
  get <recipe-id>                     Show recipe detail
  remove <recipe-id>                  Remove a recipe
  ingredients                         List ingredients
  validate <file.json>                Validate recipe without saving
  check                               Check marketplace recipes for updates

Scheduling:
  schedule                            List schedules
  schedule add <id> <cron>            Add a schedule (e.g., "*/5 * * * *")
  schedule remove <schedule-id>       Remove a schedule
  schedule enable <schedule-id>       Enable a schedule
  schedule disable <schedule-id>      Disable a schedule

LLM:
  llm                                 Show LLM config + usage
  llm set <slot> <prov> <model> <key> Configure slot (slot1 or slot2)
  llm clear <slot>                    Remove a slot
  llm budget [tokens]                 Get/set daily token budget (0=unlimited)
  llm usage                           Show today's usage + status
  llm thresholds [cut warn hard]      Get/set budget thresholds (%)

Vault:
  vault                               List stored credentials (masked)
  vault set <pub.key> <value>         Store a credential (encrypted)
  vault get <pub.key>                 Retrieve a credential
  vault delete <pub.key>              Delete a credential
  vault list [publisher]              List by publisher

Audit:
  audit                               List recent executions
  audit <run-id|recipe-id>            Show detail or filter by recipe
  audit activities                    List recent activities
  audit export                        Export full log (JSON)
  audit clear                         Clear all entries
  logs                                Show recent daemon log
  logs -f                             Follow daemon log (tail -f)

Flags:
  --port <n>                          HTTP port (default: 7717)
  --db <path>                         SQLite path (default: ./recued-server.db)
  --context '{"entity_id":"123"}'     Context for run
  --config '{"key":"value"}'          Config overrides for run
  --publisher <id>                    Publisher id for import/install
  --json                              Raw JSON output (for run)
  --webhook-url <url>                 POST results to URL on scheduled runs
```

### Running a recipe

```bash
# By recipe ID (must be imported/installed first)
npx tsx src/bin.ts run assess-deal-risk-hubspot

# With config and context overrides
npx tsx src/bin.ts run assess-deal-risk-hubspot \
  --config '{"threshold": 70}' \
  --context '{"entity_id": "12345"}'

# Raw JSON output
npx tsx src/bin.ts run assess-deal-risk-hubspot --json
```

If running interactively (TTY), the CLI prompts for any missing variables and vault credentials. In non-interactive mode, it lists what is missing and exits.

### Importing and installing recipes

```bash
# Import a local recipe JSON or recipe bundle
npx tsx src/bin.ts import ./my-recipe.json

# Install from the marketplace by slug
npx tsx src/bin.ts install assess-deal-risk-hubspot

# Install from a URL
npx tsx src/bin.ts install https://example.com/recipe.json

# Check for marketplace updates
npx tsx src/bin.ts check

# Update all marketplace recipes
npx tsx src/bin.ts update
```

The `import` command auto-detects whether the file is a bare recipe or a recipe bundle. Bundled ingredients are registered; missing ingredients are fetched from the marketplace.

### Validating recipes

```bash
npx tsx src/bin.ts validate ./my-recipe.json
```

Runs four checks without saving: schema validation, ingredient availability, variable/vault preflight, and server role restrictions (DOM/chat ingredients are flagged as blocked).

## Configuration

### Environment variables

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `7717` | HTTP listen port |
| `DB_PATH` | `./recued-server.db` | SQLite database path |
| `RECUED_WEBHOOK_URL` | -- | POST scheduled execution results to this URL |
| `RECUED_WEBHOOK_CLOCK_AUTHORITY_URL` | -- | Boot-pinned independent HTTPS time endpoint. It must return a fresh `Date` and exactly echo the request's `X-Recued-Clock-Nonce`; bounded cache-busting HEAD probes gate timestamped webhook profiles. Unset keeps them disabled. |
| `RECUED_VAULT_*` | -- | Vault entries (see below) |
| `RECUED_LLM_PROVIDER` | -- | Slot 1 provider (`openai`, `anthropic`, `google`, etc.) |
| `RECUED_LLM_MODEL` | -- | Slot 1 model name |
| `RECUED_LLM_API_KEY` | -- | Slot 1 API key |
| `RECUED_LLM_BASE_URL` | -- | Slot 1 base URL (optional, for proxies) |
| `RECUED_LLM_SLOT2_PROVIDER` | -- | Slot 2 provider |
| `RECUED_LLM_SLOT2_MODEL` | -- | Slot 2 model name |
| `RECUED_LLM_SLOT2_API_KEY` | -- | Slot 2 API key |
| `RECUED_LLM_SLOT2_BASE_URL` | -- | Slot 2 base URL (optional) |

### Vault sources

Vault entries are resolved from two sources, merged over the encrypted store
(later wins on an exact key collision):

1. **Per-request overrides** -- `vault` field in `POST /execute` body
2. **Environment variables** -- `RECUED_VAULT_{key}=value`; the key is lower-cased
   and otherwise passed through verbatim (underscores are not separators and have
   no escape)
3. **Encrypted VaultStore** -- credentials stored via `vault set`, persisted in
   SQLite under AES-256-GCM. On an enrolled server the key is `sub_dek.vault`,
   HKDF-derived from the Master DEK; pre-D-148 installs stay on the legacy
   per-server DEK row

```bash
# Via environment (unscoped -- see below)
export RECUED_VAULT_hubspot_token=pat-na1-xxxxx

# Via CLI (encrypted, persisted, publisher-scoped)
npx tsx src/bin.ts vault set recued-core.hubspot_token pat-na1-xxxxx
```

⚠ **Env entries are unscoped and are not a substitute for stored credentials.** An
environment variable name is a single flat token, so it cannot express the
`<publisher>.<key>` scoping the encrypted store uses. The two therefore land at
different reference paths -- `{{vault.hubspot_token}}` for the example above versus
`{{vault.recued-core.hubspot_token}}` for the stored one -- and do not shadow each
other unless a variable is named exactly like a publisher scope. Env is a bootstrap
channel for headless servers that must run before anyone pairs a client (until then
the encrypted store is empty or locked, so it contributes nothing); it is plaintext
in the process environment, is inherited by child processes, and is unaffected by
the vault lock and by at-rest database encryption. Prefer `vault set` for anything
long-lived.

### LLM slots

The server uses two LLM slots matching the clients' model:

| Slot | Model hint | Purpose |
|:---|:---|:---|
| `slot_1` | `fast` | Quick AI tasks (classification, extraction) |
| `slot_2` | `quality` / `thinking` | Complex reasoning, scoring |

Configured via environment variables, the `llm` CLI, or the SQLite-persisted config (priority: env > SQLite).

```bash
# Via environment
export RECUED_LLM_PROVIDER=openai
export RECUED_LLM_MODEL=gpt-4.1-mini
export RECUED_LLM_API_KEY=sk-...

# Via CLI (persisted)
npx tsx src/bin.ts llm set slot1 openai gpt-4.1-mini sk-...
npx tsx src/bin.ts llm set slot2 anthropic claude-sonnet-4-20250514 sk-ant-...
```

### Budget thresholds

Daily token budget prevents runaway AI costs. Three thresholds control behavior:

| Threshold | Default | Effect |
|:---|:---|:---|
| `schedule_cutoff` | 80% | Scheduled recipes stop running |
| `warning` | 95% | Warning logged, schedules still blocked |
| `hard_limit` | 100% | All AI calls blocked until next day |

```bash
npx tsx src/bin.ts llm budget 100000        # set daily budget to 100k tokens
npx tsx src/bin.ts llm usage                # check today's usage
npx tsx src/bin.ts llm thresholds 70 90 100 # custom thresholds
```

Budget resets daily. Setting budget to 0 means unlimited.

## Architecture

### Shared packages

The server imports directly from the monorepo workspace:

| Package | Use |
|:---|:---|
| `@recued/contracts` | Types, operators, namespaces, error codes |
| `@recued/engine` | Recipe execution orchestrator (`executeRecipe`) |
| `@recued/ingredients` | HTTP, MCP, LLM adapters |
| `@recued/llm` | LLM executor, model routing, BYOK API |
| `@recued/recipes` | Recipe validation, parsing |
| `@recued/storage` | Audit log store |
| `@recued/instances` | Instance UUID generation |

### Source layout

```
backend/server/src/
  bin.ts              CLI entrypoint + subcommand dispatch
  server.ts           HTTP server + route table
  ws-server.ts        WebSocket server (client pairing)
  mcp-server.ts       MCP stdio server (JSON-RPC 2.0)
  server-executor.ts  Ingredient executor (HTTP, MCP, LLM adapters)
  execute-handler.ts  POST /execute handler
  recipe-handlers.ts  Recipe CRUD handlers (import, install, update)
  recipe-store.ts     SQLite recipe storage
  handlers.ts         Sync endpoint handlers (vault, instances, schedules)
  scheduler.ts        Cron tick loop
  cron.ts             Cron expression parser
  daemon.ts           Background process management (start/stop/status)
  pairing.ts          Client pairing flow (code -> token)
  server-vault.ts     Encrypted vault store (AES-256-GCM, device-local DEK)
  llm-config.ts       LLM slot + budget config (SQLite-persisted)
  manifest-loader.ts  Ingredient manifest registry
  marketplace-client.ts  Marketplace API client
  preflight.ts        Pre-run checks (variables, vault, ingredients)
  webhook.ts          POST results to external URL on scheduled runs
  console-output.ts   Pretty-printed CLI output
  storage.ts          In-memory storage (tests)
  storage-sqlite.ts   SQLite storage (production)
  sqlite-collection.ts  Generic SQLite collection adapter
  types.ts            API request/response types
```

### Ingredient support

| Adapter | Support | Notes |
|:---|:---|:---|
| HTTP | Full | `fetch` is global in Node 18+ |
| MCP | Full | JSON-RPC over HTTP |
| LLM | Full | Requires BYOK API keys in slot_1/slot_2 |
| Chat | Delegated | Broadcasts to connected Bridge via WebSocket |
| DOM | Unsupported | No browser -- throws `INGREDIENT_ADAPTER_ALL_FAILED` |

## MCP integration

The server implements the MCP (Model Context Protocol) over stdio, exposing recipes as tools for AI agents.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recued": {
      "command": "npx",
      "args": ["tsx", "/path/to/recued/backend/server/src/bin.ts", "--mcp"],
      "env": {
        "RECUED_LLM_PROVIDER": "anthropic",
        "RECUED_LLM_MODEL": "claude-sonnet-4-20250514",
        "RECUED_LLM_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "recued": {
      "command": "npx",
      "args": ["tsx", "/path/to/recued/backend/server/src/bin.ts", "--mcp"]
    }
  }
}
```

### MCP tools

| Tool | Description |
|:---|:---|
| `recued_runRecipe` | Execute a recipe by ID or inline definition |
| `recued_listRecipes` | List available recipes |
| `recued_listIngredients` | List available ingredients |
| `recued_addSchedule` | Schedule a recipe on a cron expression |
| `recued_listSchedules` | List all scheduled recipes |
| `recued_removeSchedule` | Remove a scheduled recipe |
| `recued_getAudit` | Get recent execution audit entries |
| `recued_setVault` | Store a credential in the server vault |
| `recued_checkHealth` | Check recipes for upstream updates |
| `recued_validateRecipe` | Validate a recipe definition without executing |

The MCP server uses JSON-RPC 2.0 over stdin/stdout (one JSON object per line). Protocol version: `2024-11-05`.

## WebSocket protocol

The server upgrades HTTP connections on `/ws` to WebSocket for real-time communication between the server and connected clients.

### Connection

```
ws://localhost:7717/ws?token=<realm_token>
```

Auth via `Authorization: Bearer <token>` header or `?token=` query parameter.

### Messages: client -> server

| Type | Fields | Purpose |
|:---|:---|:---|
| `register` | `instance_id`, `display_name?`, `platform?` | Register this client instance |
| `ping` | -- | Keepalive |
| `command_ack` | `command_id` | Acknowledge a received command |
| `ai_response` | `request_id`, `result` or `error` | Return an AI delegation result |
| `chat_claim` | `request_id` | Claim a chat delegation broadcast |
| `chat_result` | `request_id`, `result` or `error` | Return a chat delegation result |

### Messages: server -> client

| Type | Fields | Purpose |
|:---|:---|:---|
| `registered` | `instance_id` | Confirm registration |
| `pong` | -- | Keepalive response |
| `command` | `command` | Push a command (e.g., run a scheduled recipe) |
| `ai_request` | `request_id`, `slug`, `input` | Delegate an AI call to the Bridge |
| `chat_broadcast` | `request_id`, `slug` | Broadcast a chat ingredient -- Bridges claim to execute |
| `chat_confirmed` | `request_id`, `slug`, `input` | Confirm claim with full input (winner only) |
| `chat_revoked` | `request_id` | Revoke -- another Bridge won the claim |

### Chat delegation flow

When a recipe uses a chat ingredient (e.g., `web-chat-gemini`), the server cannot execute it directly. Instead:

1. Server broadcasts `chat_broadcast` to all connected Bridges
2. Bridges that can handle it respond with `chat_claim`
3. First claim wins: server sends `chat_confirmed` to the winner, `chat_revoked` to others
4. Winner executes the chat ingredient and returns `chat_result`
5. Server continues recipe execution with the result

AI delegation follows a simpler pattern: the server sends `ai_request` to the first connected client and waits for `ai_response`. Timeout: 60s for AI, 120s for chat.

## Scheduling

The scheduler ticks every 30 seconds, checking for due schedules.

### Execution routing

- **No `target_instance_id`**: the server executes the recipe directly using its own adapters.
- **With `target_instance_id`**: the server enqueues a `run_recipe` command, delivered via WebSocket (instant) or the heartbeat poll endpoint (fallback).

### Budget cutoff

When the daily token budget reaches the `schedule_cutoff` threshold (default 80%), all scheduled executions are skipped. Manual runs via `POST /execute` and CLI `run` are unaffected until the `hard_limit` (100%) is reached.

### Webhook

Configure `--webhook-url` or `RECUED_WEBHOOK_URL` to POST results after each scheduled execution. Payload:

```json
{
  "recipe_id": "...",
  "success": true,
  "duration_ms": 1234,
  "output": { "sidebar": [...] },
  "errors": [],
  "trigger_source": "scheduled",
  "timestamp": "2026-04-15T12:00:00.000Z"
}
```

Webhook is fire-and-forget -- failures never block recipe execution. Timeout: 10s.

## API endpoints

All endpoints require `Authorization: Bearer <realm_token>` except `POST /auth/pair`.

### Pairing

| Method | Path | Description |
|:---|:---|:---|
| `POST` | `/auth/pair` | Exchange a pairing code for a realm token |

### Execution

| Method | Path | Description |
|:---|:---|:---|
| `POST` | `/execute` | Execute a recipe (by ID or inline) |
| `GET` | `/ingredients` | List available ingredients |

### Recipes

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/recipes` | List all recipes |
| `GET` | `/recipes/:id` | Get recipe detail |
| `DELETE` | `/recipes/:id` | Remove a recipe |
| `POST` | `/recipes/import` | Import a recipe JSON |
| `POST` | `/recipes/install` | Install from marketplace (by slug or URL) |
| `POST` | `/recipes/import-bundle` | Import a SyncBundle |
| `POST` | `/recipes/update` | Update all marketplace recipes |
| `POST` | `/recipes/:id/update` | Update one marketplace recipe |

### Vault

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/vault` | List encrypted vault entries |
| `GET` | `/vault/:key` | Get a vault entry |
| `PUT` | `/vault/:key` | Store a vault entry |
| `DELETE` | `/vault/:key` | Delete a vault entry |
| `GET` | `/realm-key` | Get the wrapped DEK for cross-device sync |
| `PUT` | `/realm-key` | Store the wrapped DEK |

### Instances

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/instances` | List device roster |
| `POST` | `/instances` | Register a new device |
| `DELETE` | `/instances/:id` | Deregister a device |
| `POST` | `/instances/:id/heartbeat` | Heartbeat + receive pending commands |

### Schedules

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/schedules` | List scheduled recipes |
| `POST` | `/schedules` | Create a schedule |
| `PATCH` | `/schedules/:id` | Update a schedule |
| `DELETE` | `/schedules/:id` | Remove a schedule |

### Commands

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/commands` | List pending commands |
| `POST` | `/commands/:id/ack` | Acknowledge a command |

### Executions

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/executions` | List execution history |
| `GET` | `/executions/:id` | Get a single execution |
| `POST` | `/executions` | Push an execution summary |

### Audit log

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/audit` | List recent audit entries |
| `GET` | `/audit/activities` | List recent activities |
| `GET` | `/audit/export` | Export full audit log (GDPR/compliance) |
| `GET` | `/audit/:run_id` | Get a single audit entry |
| `DELETE` | `/audit` | Clear all audit entries |

### Health

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/health` | Server status (`{ status: 'ok', now: <epoch_ms> }`) |

## Development

```bash
npm run dev       # start with auto-reload (tsx --watch)
npm run build     # tsc --build
npm test          # vitest run
```

### Testing

Tests use `vitest` and spin up server instances on random ports (`port: 0`). The in-memory storage backend is used by default in tests -- no SQLite required.

### Dependencies

- `better-sqlite3` -- SQLite driver (embedded, no external DB)
- `ws` -- WebSocket server (used for client pairing)
- Workspace packages: `@recued/contracts`, `@recued/engine`, `@recued/ingredients`, `@recued/instances`, `@recued/llm`, `@recued/recipes`, `@recued/storage`

## Security

- **Realm token** is the sole auth credential. Treat it like a password (32+ chars, do not commit).
- **Vault store** encrypts credentials with AES-256-GCM using a device-local DEK. The server stores ciphertext only -- even with full database access, vault secrets are unreadable.
- **Pairing code** is single-use, 8 alphanumeric characters, expires after 15 minutes. Issued on server start and displayed in the terminal.
- **CRM data** is called by THIS SERVER, directly, using locally-stored personal access tokens. It never routes through Recued Cloud. (This line used to say the opposite — that the client called CRM APIs — which was true before the server became the sole orchestrator.)
