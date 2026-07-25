/** D-178 — the `recued update` CLI profile.
 *
 *  A standalone, channel-INDEPENDENT update CHECK from the terminal — the
 *  counterpart to the owner-device `update.check` rpc (the webclient surface).
 *  The D-178 model is "identifier-free check / channel-aware apply": the check
 *  works on EVERY install (binary, docker, source self-build) because it only
 *  fetches + verifies the signed manifest and resolves it locally. Whether the
 *  install can self-APPLY is a separate, channel-gated question — so this
 *  profile always offers the check and reports apply availability honestly
 *  rather than hiding the check on delegated channels.
 *
 *  Apply / rollback are deliberately NOT CLI verbs: they mutate the live binary
 *  and require a restart of the RUNNING daemon, which a standalone CLI process
 *  can't drive — those stay the server's job (webclient → Settings → Updates,
 *  via the owner-only `update.apply` / `update.rollback` rpc). `recued update
 *  apply` prints that pointer instead of half-applying.
 *
 *  Standalone like the `audit` / `archive` profiles: open the db (for the
 *  rollout salt + anti-replay floor in `server_state`), build the check deps,
 *  run, print, close. Pre-GA (no trusted release key wired yet) the check
 *  resolves to `not-configured` and says so.
 */

import { getArg, parsePositionals } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { openDatabase } from '../open-database.js';
import { buildReleaseCheckDeps, resolveDistributionChannel } from '../update/release-config.js';
import { runReleaseCheck } from '../update/release-check.js';
import type { ReleaseCheckResponse } from '@recued/contracts';
import type { DistributionChannel } from '../update/update-mode-store.js';

export interface UpdateProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  serverVersion: string;
  env?: NodeJS.ProcessEnv;
}

/** Channels whose binary self-applies (mirrors release-config's
 *  `SELF_APPLY_CHANNELS`) — used only to phrase the apply guidance. */
const selfApplies = (channel: DistributionChannel): boolean =>
  channel === 'binary' || channel === 'docker-thin';

/** One line on HOW this install takes an available update, given its channel. */
const applyGuidance = (channel: DistributionChannel): string => {
  if (selfApplies(channel)) {
    return 'Apply it from the webclient: Settings → Updates (the running server stages + restarts).';
  }
  if (channel === 'docker-baked') {
    return 'This install updates by re-pulling the pinned image — see the release notes for the new digest.';
  }
  if (channel === 'source') {
    return 'This is a source build — rebuild from the tagged release to update.';
  }
  return 'See the release notes to update this install.';
};

const printCheck = (res: ReleaseCheckResponse, channel: DistributionChannel): void => {
  const head = `recued ${res.current_version} (${res.channel} channel)`;
  switch (res.status) {
    case 'up-to-date':
      console.log(`${head} — up to date.`);
      return;
    case 'update-available': {
      const a = res.available!;
      console.log(`${head} — update available: ${a.version}${a.is_major ? ' (major)' : ''}.`);
      if (a.below_min_supported) console.log('  ⚠ Your version is below the minimum supported — updating is URGENT.');
      if (a.migration) console.log('  This release migrates the database on first boot (a snapshot is taken for rollback).');
      console.log(`  ${applyGuidance(channel)}`);
      if (a.notes_url) console.log(`  Release notes: ${a.notes_url}`);
      return;
    }
    case 'not-configured':
      console.log(`${head} — update checks are not available on this build yet (no signing key).`);
      return;
    case 'stale-feed':
      console.log(`${head} — the release feed is stale (past its freshness window). Not acting on it.`);
      return;
    case 'launcher-outdated':
      console.log(`${head} — the launcher is too old to apply updates; update the launcher first.`);
      return;
    case 'replay':
      console.log(`${head} — the release feed served an older manifest than we've already seen (refused).`);
      return;
    case 'fetch-failed':
      console.log(`${head} — could not reach the release feed${res.detail ? `: ${res.detail}` : ''}.`);
      return;
    case 'bad-signature':
      console.log(`${head} — the release manifest failed signature verification${res.detail ? `: ${res.detail}` : ''}.`);
      return;
  }
};

export async function runUpdateProfile(options: UpdateProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const positionals = parsePositionals(options.args);
  const sub = positionals[1] ?? 'check';
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';

  if (sub === 'apply' || sub === 'rollback') {
    // These mutate the live binary + restart the running daemon — the standalone
    // CLI can't drive that. Point at the server-owned surface instead.
    console.error(
      `\`recued update ${sub}\` runs on the live server (it stages the binary + restarts), not from the CLI.\n` +
        'Use the webclient: Settings → Updates.',
    );
    process.exitCode = 2;
    return;
  }
  if (sub !== 'check') {
    console.error(`Unknown subcommand \`recued update ${sub}\`. Try \`recued update\` (check) or \`recued update check\`.`);
    process.exitCode = 2;
    return;
  }

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = await openDatabase(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');

    const deps = buildReleaseCheckDeps({ db, currentVersion: options.serverVersion, env });
    if (!deps) {
      console.log('Updates are not supported on this platform.');
      return;
    }
    const res = await runReleaseCheck(deps);
    printCheck(res, resolveDistributionChannel(env));
  } finally {
    db.close();
  }
}
