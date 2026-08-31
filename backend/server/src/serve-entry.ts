/** Foreground serve composition for the production router.
 *
 * Heavy server/runtime imports are intentionally inside serve() so importing
 * this module alone cannot open SQLite, bind listeners, start schedulers,
 * print the boot banner, or install signal handlers.
 */

import { composeBaseContext } from "./serve/compose-base-context.js";
import { SERVER_VERSION } from "./server-version.js";

export async function serve(inputArgs: string[]): Promise<void> {
const {
  setRole,
} = await import("@recued/contracts");
setRole('server');

// ────────────────────────────────────────────────────────────────
// Base parse/config context
// ────────────────────────────────────────────────────────────────

const baseContext = composeBaseContext(inputArgs);
const { bootTrace } = baseContext;

// ── `--pair-code-ttl <7d|12h|30m|900000>` ────────────────────────────────────
//
// A pairing code is single-use AND expires in 15 minutes, which fits a human at
// the terminal and fails an asynchronous reviewer: Chrome Web Store review can
// begin days after submission, by which time the code in the dashboard notes is
// long dead and the extension is untestable.
//
// ⛔ THIS FLAG IS ON `serve`, NOT ON `pair`, AND THAT IS LOAD-BEARING. The code
// is closure state in the pairing manager, never persisted, so the manager the
// RUNNING server holds is the only one `/auth/pair` checks. `recued pair` builds
// its own manager in a separate process; a `--ttl` there would print a long TTL
// beside a code the server rejects.
//
// Written to the env the resolver already reads rather than threaded through the
// composition root: it is a deployment knob, not a composition input, and one
// resolution point cannot drift from another.
const { getArg, getFlag } = await import('./cli/parse.js');
const pairCodeTtlRaw = getArg(inputArgs, 'pair-code-ttl');
if (pairCodeTtlRaw !== undefined) {
  const { parsePairCodeTtl } = await import('./pairing.js');
  const ms = parsePairCodeTtl(pairCodeTtlRaw);
  if (ms === undefined) {
    console.error(
      `Invalid --pair-code-ttl '${pairCodeTtlRaw}'. Use a positive number with an optional unit: 900000, 30m, 12h, 7d.`,
    );
    process.exitCode = 1;
    return;
  }
  process.env.RECUED_PAIR_CODE_TTL_MS = String(ms);
}

// ── `--require-enrolled` ─────────────────────────────────────────────────────
//
// Refuse to serve a realm that has never been set up. Autostart units pass this;
// an interactive `recued serve` must NOT, because enrolment happens THROUGH a
// running server (/auth/pair with a recovery key) and a server that refuses to
// start can never be enrolled.
//
// ⛔ WHAT IT PREVENTS. An autostart unit armed at install time boots a server
// that nobody has configured — listening on 0.0.0.0 (a detected LAN address
// binds every interface), holding a live pairing code that prints to a log the
// owner never reads. Nothing legitimate can use that server, because the one
// credential needed to adopt it went to /dev/null. Refusing is strictly better
// than listening.
//
// ⛔⛔ EXIT 0, NOT NON-ZERO, AND THAT IS LOAD-BEARING. Both units restart on
// failure — systemd `Restart=on-failure`, and launchd
// `KeepAlive{SuccessfulExit:false}` which restarts anything that exits
// non-zero. A refusal is an expected steady state, not a crash; exiting
// non-zero would put an unconfigured machine into a restart loop that never
// resolves, because nothing about rebooting enrols a realm.
if (getFlag(inputArgs, 'require-enrolled')) {
  const { getArg: getArgFor } = await import('./cli/parse.js');
  const { resolveRealmDbPath } = await import('./realm-db-path.js');
  const dbPath = resolveRealmDbPath(getArgFor(inputArgs, 'db') ?? process.env.DB_PATH);
  const { openDatabase: open } = await import('./open-database.js');
  const { createRecoveryKeyCheckStore } = await import('./recovery-key-store.js');
  let enrolled = false;
  let probeError: unknown;
  try {
    const probe = await open(dbPath);
    try { enrolled = createRecoveryKeyCheckStore(probe).exists(); } finally { probe.close(); }
  } catch (err) {
    probeError = err;
  }

  // ⛔⛔ AN UNOPENABLE REALM IS NOT AN UNENROLLED ONE, AND THE DIFFERENCE
  // DECIDES WHETHER TO RETRY. This catch used to collapse the two: any open
  // failure reported "no recovery key enrolled" and exited 0. Measured
  // 2026-08-22 on a realm that WAS enrolled and was merely unreadable — the
  // server told the owner to re-pair a realm that needed nothing, and because
  // exit 0 is precisely the signal both supervisors read as "do not restart" —
  // MEASURED ON BOTH, same boot, two stub units differing only in exit code:
  // systemd PID 1 (`Restart=on-failure`) ran the exit-0 unit ONCE and settled
  // `inactive`, and restarted the exit-1 unit 5× in 6s; launchd
  // (`KeepAlive{SuccessfulExit:false}`) ran the exit-0 job ONCE in 70s and
  // respawned the exit-1 job 9× on its ~10s throttle — a TRANSIENT failure
  // became a PERMANENT one.
  //
  // ⚠ THE TWO DIFFER ON GIVING UP, WHICH CHANGES WHERE THE OWNER LOOKS. systemd
  // stops after `StartLimitBurst` (5) and parks the unit `failed`, visible in
  // `systemctl status`. launchd NEVER gives up — it respawns every ~10s
  // indefinitely — so on macOS the only evidence is this message repeating in
  // the log. Both beat a silent permanent failure; only one is visible without
  // reading logs.
  // A volume not yet mounted, a WAL recovery lock, permissions after a restore,
  // or a native addon broken by a Node upgrade all land here.
  //
  // 🔑 THE RULE THE ORIGINAL COMMENT REACHED FOR. Refusing without retry is
  // right when nothing about retrying can change the outcome — no amount of
  // rebooting enrols a realm. It is wrong when a retry CAN succeed. So an
  // unenrolled realm still exits 0, and an unopenable one exits non-zero and
  // says what actually broke.
  if (probeError) {
    console.error('[recued] cannot open the realm database: ' + String(dbPath));
    console.error('[recued]   ' + (probeError instanceof Error ? probeError.message : String(probeError)));
    console.error('[recued] This is NOT "not set up yet" — enrolment state is unknown because');
    console.error('[recued] the database could not be read. Fix the cause above; autostart will');
    console.error('[recued] retry. If this realm is genuinely new, run `recued serve` yourself.');
    process.exitCode = 1;
    return;
  }

  // ⛔ D-252 — AN UNENROLLED REALM IS SERVED, NOT REFUSED. This used to return
  // here, and that refusal was the whole reason first run took two phases: the
  // unit could not be the thing you pair to, so the owner had to run a server in
  // a terminal, pair, and then hand off to a supervisor with nothing telling them
  // how. The natural guess was `recued start` — a DIFFERENT supervision
  // mechanism that contends with the unit for the same realm.
  //
  // 🔑 WHAT MADE THE REFUSAL SAFE TO DROP, and it is not "we decided the risk is
  // fine". The stated danger was an unconfigured server "listening on 0.0.0.0
  // holding a live pairing code that prints to a log the owner never reads.
  // Nothing legitimate can use that server, because the one credential needed to
  // adopt it went to /dev/null." Both halves are already answered:
  //
  //   · ADOPTION IS CODE-GATED AT THE SERVER, not in the client form. `server.ts`
  //     refuses `!realmEnrolled && !code` with 400 "code is required for the
  //     first pair on this server", evaluated BEFORE any recovery-key side
  //     effect. Reachable and unenrolled is not adoptable.
  //   · `recued pair` IS THAT CREDENTIAL PATH. It needs no running server, mints
  //     against the db, and REFRESHES the single live code — so the copy in a
  //     boot log is superseded the moment the owner runs it, and expires anyway.
  //
  // ⛔⛔ THE OTHER HALF OF THIS FLAG STAYS. `--require-enrolled` also separates an
  // unenrolled realm from an UNOPENABLE one, and that difference decides whether
  // the supervisor retries — see the measurement above. Only the enrolment
  // refusal is gone; the `probeError` branch is untouched.
  //
  // ⚠ ONLY UNITS PASS THIS FLAG, so a hand-run `recued serve` is unaffected
  // either way, and `RECUED_AUTOSTART=0` keeps the old flow by never arming a
  // unit at all.
  if (!enrolled) {
    console.log('[recued] this realm is not set up yet, and the server is running so you can');
    console.log('[recued] finish it without a terminal session:');
    console.log('[recued]     recued pair          # prints a pairing code + the pair link');
    console.log('[recued] then pair a client. Nothing can adopt this server without that code.');
  }
}

// Server version (surfaces on `ServerStatus` rpc + the boot banner + the archive
// restore `min_consumer_version` check) — resolved once in `./server-version`.

let cleanup = (): void => {};

// ────────────────────────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────────────────────────

const dispatch = async (): Promise<void> => {
  bootTrace.mark('dispatch-start');
  const { startPostBaseStorageVaultRuntime } =
    await import("./serve/start-post-storage-app-collection-execution-runtime.js");
  await startPostBaseStorageVaultRuntime({
    base: baseContext,
    serverVersion: SERVER_VERSION,
    env: process.env,
    publishDbCleanup: (nextCleanup) => {
      cleanup = nextCleanup;
    },
  });
};

try {
  await dispatch();
  bootTrace.finish('dispatch-complete');
} catch (e) {
  bootTrace.finish('dispatch-error', e instanceof Error ? e.message : String(e));
  cleanup();
  throw e;
}
}
