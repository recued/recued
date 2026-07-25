/** D-178 — the thin `:managed` image entrypoint.
 *
 *  Bundled standalone (`scripts/build.mjs` → `dist/managed-launcher.js`) so the
 *  `:managed` image carries ONLY this launcher + node — never the server bundle
 *  (the binary it launches lives on the data volume). Embeds the pinned release
 *  pubkey (inlined by esbuild) + delegates to `runLauncher`.
 *
 *  Frozen: it imports the verify-and-exec loop + the single pinned-key constant,
 *  nothing else from the server graph (I-9). */

import { runLauncher } from './managed-launcher.js';
import { TRUSTED_RELEASE_PUBKEY } from '../update/trusted-release-pubkey.js';

const main = async (): Promise<void> => {
  // Args after `node managed-launcher.js` are forwarded verbatim to the server
  // binary (e.g. `--db /data/recued.db --config /etc/recued/config.toml`).
  const args = process.argv.slice(2);
  const code = await runLauncher({
    pubkey: TRUSTED_RELEASE_PUBKEY,
    args,
    ...(process.env.RECUED_BIN_DIR ? { binDir: process.env.RECUED_BIN_DIR } : {}),
    // The image bakes the initial binary here; the launcher seeds it onto an
    // empty data volume on first boot, then the server self-updates the volume.
    seedBinaryPath: process.env.RECUED_SEED_BIN ?? '/opt/recued-seed/recued',
  });
  process.exit(code);
};

void main();
