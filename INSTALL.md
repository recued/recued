# Installing Recued

## Requirements

- Node.js 20 or newer.
- npm with lockfile v3 support.
- Platform build tools supported by `better-sqlite3` when a prebuilt binary is unavailable.

## Build from a clone

```sh
git clone https://github.com/recued/recued.git
cd recued
npm ci
npm run build
npm run build:server
npm run build:webclient
```

`npm ci` installs exactly the dependency versions recorded in the public lockfile. The build commands type-check the public workspace graph, bundle the server, and create the production webclient under `apps/webclient/build/`.

## Start the server and local webclient

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
