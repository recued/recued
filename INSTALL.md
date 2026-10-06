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

Linux and Windows on x64 or arm64. macOS on Apple Silicon and Intel — both
signed and notarized with a Developer ID.

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

- Node.js 24.
- npm with lockfile v3 support.
- Platform build tools supported by `better-sqlite3` when a prebuilt binary is unavailable.

### Build from a clone

Linux and macOS:

```sh
git clone https://github.com/recued/recued.git
cd recued
npm ci
npm run build
npm run build:server
npm run build:webclient
```

Windows, in PowerShell:

```powershell
git clone https://github.com/recued/recued.git
cd recued
npm.cmd ci
npm.cmd run build
npm.cmd run build:server
npm.cmd run build:webclient
```

In PowerShell, type `npm.cmd`, not `npm`. On Windows 10 and 11, PowerShell's default execution policy refuses the `npm.ps1` script that a plain `npm` runs ("running scripts is disabled on this system"); `npm.cmd` is the same npm and needs no policy change. In Command Prompt, plain `npm` works.

No Git on Windows? Download the source instead of cloning it, then run the `npm.cmd` lines above from inside `recued-main`:

```powershell
Invoke-WebRequest https://github.com/recued/recued/archive/refs/heads/main.zip -OutFile recued.zip
Expand-Archive recued.zip -DestinationPath .
cd recued-main
```

`npm ci` installs exactly the dependency versions recorded in the public lockfile. The build commands type-check the public workspace graph, bundle the server, and create the production webclient under `apps/webclient/build/`.

### Start the server and local webclient

Linux and macOS:

```sh
RECUED_WEBCLIENT_DIR="$PWD/apps/webclient/build" npm start
```

Windows, in PowerShell:

```powershell
$env:RECUED_WEBCLIENT_DIR = "$PWD\apps\webclient\build"
npm.cmd start
```

The server listens on port `7717` by default. Open:

```text
http://localhost:7717/webclient/
```

For a watched server process during development, run `npm run dev` (Windows: `npm.cmd run dev`) in place of `npm start`, with `RECUED_WEBCLIENT_DIR` set the same way.

Runtime databases, identity material, logs, and local environment files are ignored by Git. Keep recovery material and credentials outside the repository.

## Verification

The public repository exposes the same release gates used for its source projection:

```sh
npm run ci
```

This runs the public TypeScript build, server and webclient bundle builds, test typecheck, and test suite.
