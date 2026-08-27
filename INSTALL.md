# Installing Recued

Two ways in. Most people want the first.

## Install a released binary

One command. It fetches the signed binary for your platform, verifies it
against the release key, puts `recued` on your PATH, and sets it to start when
you log in.

```sh
# Linux and macOS
curl -fsSL https://recued.com/install.sh | sh
```

```powershell
# Windows — in PowerShell
irm https://recued.com/install.ps1 | iex
```

Linux and Windows on x64 or arm64. macOS on Apple Silicon; Intel Macs are not
published yet.

### Options

Set these before the command — `RECUED_AUTOSTART=0 curl -fsSL … | sh`. In
PowerShell, run `$env:RECUED_AUTOSTART=0` on its own line first.

| Variable | Effect |
|---|---|
| `RECUED_AUTOSTART=0` | Do not start at login. On by default. |
| `RECUED_PREFIX` | Where the payload goes. Default `/usr/local/lib/recued`. |
| `RECUED_BINDIR` | Where the `recued` command goes. Default `/usr/local/bin`. Set both to install without `sudo`. |
| `RECUED_CHANNEL=edge` | Follow the edge channel instead of stable. |
| `RECUED_FORCE=1` | Reinstall even when already on the released version. |

### Start at login, per platform

| Platform | What it installs | Root needed |
|---|---|---|
| macOS | a per-user LaunchAgent, starts at login | no |
| Linux desktop | a systemd **user** unit, starts at login | no |
| Linux headless | a systemd **system** unit, starts at boot | **yes — run with `sudo`** |
| Windows | a Startup-folder shortcut, starts at login | no |

Headless Linux is the one that needs root, and not for the usual reason: with
no desktop keyring, the only way to seal the keyfile to the machine is
`systemd-creds`, which reads a host key only root can read. Without root there
is no rung to seal against, so the installer arms nothing and says so rather
than writing a unit that would fail on every boot.

**Start at login gives you a supervised server, not necessarily an unattended
one.** If you seal your keyfile with a passphrase it starts locked and waits for
`recued unlock`; sealed to the machine instead, it starts ready. Either way the
unit stays idle until the realm is paired, so it never brings up an
unconfigured server listening on your network.

It is also what lets an update restart the server for you. A server you started
by hand cannot be restarted on your behalf — the database path can come from
`DB_PATH` or from the working directory, so anything guessing at it could bring
the server up on the wrong database.

Upgrading a running server: re-running the install script replaces the file but
does **not** change the process already running — it keeps the old code until it
restarts, and the script tells you so. A running server can also update itself
from the webclient: Settings → Updates.

## Build from source

Only if you want to run from a clone — the released binary needs none of this.

### Requirements

- Node.js 20 or newer.
- npm with lockfile v3 support.
- Platform build tools supported by `better-sqlite3` when a prebuilt binary is unavailable.

### Build from a clone

```sh
git clone https://github.com/recued/recued.git
cd recued
npm ci
npm run build
npm run build:server
npm run build:webclient
```

`npm ci` installs exactly the dependency versions recorded in the public lockfile. The build commands type-check the public workspace graph, bundle the server, and create the production webclient under `apps/webclient/build/`.

### Start the server and local webclient

```sh
RECUED_WEBCLIENT_DIR="$PWD/apps/webclient/build" npm start
```

The server listens on port `7717` by default. Open:

```text
http://localhost:7717/webclient/
```

For a watched server process during development:

```sh
RECUED_WEBCLIENT_DIR="$PWD/apps/webclient/build" npm run dev
```

Runtime databases, identity material, logs, and local environment files are ignored by Git. Keep recovery material and credentials outside the repository.

## Verification

The public repository exposes the same release gates used for its source projection:

```sh
npm run ci
```

This runs the public TypeScript build, server and webclient bundle builds, test typecheck, and test suite.
