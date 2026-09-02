/** ⛔⛔ ONE CHANNEL, ONE ANTI-REPLAY FLOOR — round-3 audit finding 7.
 *
 *  Release policy was split across the actuators that enforce it:
 *    · the installer selected a channel with `RECUED_CHANNEL`, the runtime read
 *      only `RECUED_UPDATE_CHANNEL`, and the generated services persisted
 *      NEITHER — so an owner who installed from `edge` got a server checking
 *      `stable`, and even a matching variable did not survive a reboot.
 *    · the installer kept its anti-replay floor in a file beside the binary and
 *      the server kept one per realm in SQLite, and neither could see the other —
 *      so a manifest the installer had refused as a replay was still honoured by
 *      the server.
 *
 *  A policy enforced differently by each actuator is not one policy. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import {
  assembleManifest,
  binaryFileName,
  generateKeypair,
  signArtifact,
  signManifest,
} from '@recued/release';

import { runReleaseCheck } from '../update/release-check.js';
import { buildReleaseCheckDeps } from '../update/release-config.js';
import {
  advanceHostSequenceFloor,
  hostSequenceFloorPathFor,
  readHostSequenceFloor,
} from '../update/host-sequence-floor.js';
import { createReleaseStateStore, type ReleaseCheckState } from '../update/release-state-store.js';

describe('the channel is one variable, and it persists', () => {
  it('the runtime resolves the channel from the INSTALLER\'s variable', () => {
    // ⚠ The first version of this arm asserted that no fetch happened, which is
    // true whatever the channel is — it could not tell the fix from its absence.
    // The observable output is the channel the built deps carry.
    const edge = buildReleaseCheckDeps({
      db: new Database(':memory:'),
      currentVersion: '1.0.0',
      env: { RECUED_CHANNEL: 'edge' },
    });
    expect(edge?.channel, 'RECUED_CHANNEL=edge must reach the runtime').toBe('edge');
  });

  it('the more specific RECUED_UPDATE_CHANNEL still wins', () => {
    const both = buildReleaseCheckDeps({
      db: new Database(':memory:'),
      currentVersion: '1.0.0',
      env: { RECUED_CHANNEL: 'edge', RECUED_UPDATE_CHANNEL: 'stable' },
    });
    expect(both?.channel).toBe('stable');
  });

  it('neither set is still stable', () => {
    const none = buildReleaseCheckDeps({
      db: new Database(':memory:'),
      currentVersion: '1.0.0',
      env: {},
    });
    expect(none?.channel).toBe('stable');
  });

  // ⚠ THE OTHER HALF OF THIS RULE LIVES IN `installer-safety-guards.test.ts`:
  // the generated units must STAMP the chosen channel, or the service forgets
  // what was installed and checks stable forever. It reads `install.sh`, which is
  // private to this repository — and reading it HERE, at module scope, omitted
  // this whole file from the public export for one assertion, taking ten tests of
  // shipped update-path behaviour out of public CI with it.
});

describe('the anti-replay floor is a property of the HOST', () => {
  // ⛔ A REAL SIGNED FEED, BECAUSE THE FLOOR IS ONLY OBSERVABLE THROUGH THE
  // RESOLUTION. The first version of these arms called its own stub inside
  // `fetchText` and asserted the stub returned 42 — true however `effectiveFloor`
  // behaved, and it would have passed with the floor ignored entirely. That is
  // how "a property of the HOST" stood as a believed claim while being false
  // across realms. Drive the manifest all the way to a status instead.
  const kp = generateKeypair();
  const binBytes = Buffer.from('fake recued-linux-x64 binary payload');
  const binName = binaryFileName('linux-x64');
  const signedAt = (sequence: number) => {
    const m = assembleManifest({
      sequence,
      expires_at: '2027-01-01T00:00:00Z',
      min_launcher_version: 1,
      channels: {
        stable: {
          version: '1.4.2',
          released_at: '2026-07-02T10:00:00Z',
          min_supported: '1.2.0',
          migration: false,
          rollout_pct: 100,
          notes_url: 'https://recued.com/notes',
          binaries: {
            'linux-x64': {
              url: `https://cdn.example/releases/1.4.2/${binName}`,
              sha256: createHash('sha256').update(binBytes).digest('hex'),
              sig: signArtifact({ content: binBytes, fileName: binName, version: '1.4.2', key: kp }),
            },
          },
        },
      },
    });
    return signManifest(m, kp);
  };
  const feed = (sequence: number) => {
    const { json, sig } = signedAt(sequence);
    return async (url: string) => (url.endsWith('.minisig') ? sig : json);
  };

  const base = {
    trustedPubkey: kp.publicKeyText,
    manifestUrl: 'http://x/manifest.json',
    channel: 'stable' as const,
    currentVersion: '1.0.0',
    platform: 'linux-x64' as const,
    saveState: () => {},
    now: () => Date.parse('2026-07-10T00:00:00Z'),
  };

  it('the INSTALL-WIDE floor raises the runtime\'s, even when SQLite says 0', async () => {
    // The realm has never seen a release; the install has accepted sequence 42.
    // A manifest at 7 must be a replay for BOTH.
    const res = await runReleaseCheck({
      ...base,
      loadState: () => ({ salt: 's', highest_accepted_sequence: 0 }),
      hostSequenceFloor: () => 42,
      fetchText: feed(7),
    });
    expect(res.status, 'the shared floor must refuse a sequence below it').toBe('replay');
  });

  it('and does not refuse a sequence ABOVE it — the arm that proves the first is not vacuous', async () => {
    const res = await runReleaseCheck({
      ...base,
      loadState: () => ({ salt: 's', highest_accepted_sequence: 0 }),
      hostSequenceFloor: () => 42,
      fetchText: feed(99),
    });
    expect(res.status).toBe('update-available');
  });

  it('a floor port that THROWS is treated as 0, not propagated', async () => {
    // A host that has never run the new installer — or one whose file is
    // unreadable — must behave exactly as before, and must never be able to
    // LOWER the realm's own floor. 7 is below the realm's 9, so `replay` here is
    // the REALM's refusal surviving a throwing shared floor.
    const res = await runReleaseCheck({
      ...base,
      loadState: () => ({ salt: 's', highest_accepted_sequence: 9 }),
      hostSequenceFloor: () => { throw new Error('EACCES'); },
      fetchText: feed(7),
    });
    expect(res.status, 'a throwing floor port must not abort the check').toBe('replay');
  });
});

/** ⛔⛔ THE FINDING ITSELF: two realms, one executable, one floor.
 *
 *  Every arm above hand-feeds a floor NUMBER, so all of them passed while the
 *  server read the shared file and never wrote it — acceptance stayed in
 *  whichever realm did the accepting. This drives the REAL module against a REAL
 *  shared file, which is the only shape that can tell those apart. */
describe('acceptance in one realm binds the other realm on the same host', () => {
  const kp = generateKeypair();
  const binBytes = Buffer.from('fake recued-linux-x64 binary payload');
  const binName = binaryFileName('linux-x64');
  const feed = (sequence: number) => {
    const m = assembleManifest({
      sequence,
      expires_at: '2027-01-01T00:00:00Z',
      min_launcher_version: 1,
      channels: {
        stable: {
          version: '1.4.2',
          released_at: '2026-07-02T10:00:00Z',
          min_supported: '1.2.0',
          migration: false,
          rollout_pct: 100,
          notes_url: 'https://recued.com/notes',
          binaries: {
            'linux-x64': {
              url: `https://cdn.example/releases/1.4.2/${binName}`,
              sha256: createHash('sha256').update(binBytes).digest('hex'),
              sig: signArtifact({ content: binBytes, fileName: binName, version: '1.4.2', key: kp }),
            },
          },
        },
      },
    });
    const { json, sig } = signManifest(m, kp);
    return async (url: string) => (url.endsWith('.minisig') ? sig : json);
  };

  /** A realm: its own SQLite state, the SHARED floor file, real ports. */
  const realmDeps = (floorPath: string, sequence: number) => {
    const db = new Database(':memory:');
    const store = createReleaseStateStore(db);
    return {
      trustedPubkey: kp.publicKeyText,
      manifestUrl: 'http://x/manifest.json',
      channel: 'stable' as const,
      currentVersion: '1.0.0',
      platform: 'linux-x64' as const,
      now: () => Date.parse('2026-07-10T00:00:00Z'),
      loadState: () => store.load(),
      saveState: (st: ReleaseCheckState) => store.save(st),
      hostSequenceFloor: () => readHostSequenceFloor(floorPath),
      advanceHostSequenceFloor: (seq: number) => { advanceHostSequenceFloor(floorPath, seq); },
      fetchText: feed(sequence),
    };
  };

  it('realm A accepting 300 makes a replayed 250 a replay in realm B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-floor-'));
    const floorPath = hostSequenceFloorPathFor(dir);
    try {
      const a = await runReleaseCheck(realmDeps(floorPath, 300));
      expect(a.status, 'realm A must accept the newer release').toBe('update-available');

      // Realm B has its own empty database and has never seen anything. Before
      // the fix its floor was 0 and this resolved `update-available`.
      const b = await runReleaseCheck(realmDeps(floorPath, 250));
      expect(b.status, 'a sequence realm A already passed must be a replay in B').toBe('replay');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-states the shared floor even when the realm has nothing new to record', async () => {
    // ⛔ THE SELF-HEALING PROPERTY, and the reason the host advance is NOT nested
    // under `advanceReplayFloor`'s higher-only guard. This realm is already at
    // 300, so it records nothing; if the shared file were only written when the
    // REALM moved, a file left behind — by an installer write that raced ours, or
    // by a prefix that was briefly unwritable — would stay behind until some
    // realm happened to see a HIGHER release.
    const dir = mkdtempSync(join(tmpdir(), 'recued-floor-heal-'));
    const floorPath = hostSequenceFloorPathFor(dir);
    try {
      const db = new Database(':memory:');
      const store = createReleaseStateStore(db);
      store.save({ salt: 's', highest_accepted_sequence: 300 });
      await runReleaseCheck({
        trustedPubkey: kp.publicKeyText,
        manifestUrl: 'http://x/manifest.json',
        channel: 'stable' as const,
        currentVersion: '1.0.0',
        platform: 'linux-x64' as const,
        now: () => Date.parse('2026-07-10T00:00:00Z'),
        loadState: () => store.load(),
        saveState: (st: ReleaseCheckState) => store.save(st),
        hostSequenceFloor: () => readHostSequenceFloor(floorPath),
        advanceHostSequenceFloor: (seq: number) => { advanceHostSequenceFloor(floorPath, seq); },
        fetchText: feed(300),
      });
      expect(
        readHostSequenceFloor(floorPath),
        'a realm that recorded nothing must still converge the shared floor',
      ).toBe(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unwritable prefix degrades to per-realm rather than failing the check', async () => {
    // The documented fallback. `/proc/nonexistent` cannot be created on either
    // platform this suite runs on, so the writer reports `unwritable`.
    const floorPath = join('/proc', 'recued-nonexistent-dir', '.release-sequence');
    const res = await runReleaseCheck(realmDeps(floorPath, 300));
    expect(res.status, 'an unwritable shared floor must not fail the check').toBe('update-available');
  });
});

/** ⛔ THE PORT EXISTS ≠ THE PORT IS WIRED. Every arm above hands the writer in by
 *  hand; a `buildReleaseCheckDeps` that forgot it would leave them all green and
 *  the product per-realm. Assert the composition root itself. */
describe('the real composition root wires BOTH floor ports to one file', () => {
  it('buildReleaseCheckDeps writes the floor file it reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-floor-wire-'));
    try {
      const deps = buildReleaseCheckDeps({
        db: new Database(':memory:'),
        currentVersion: '1.0.0',
        // docker-thin is the one channel whose binary directory is env-derived,
        // so it is how a test can own the directory the ports resolve to.
        env: { RECUED_DISTRIBUTION_CHANNEL: 'docker-thin', RECUED_BIN_DIR: dir },
      });
      expect(deps?.advanceHostSequenceFloor, 'the writer port must be wired').toBeTypeOf('function');
      deps?.advanceHostSequenceFloor?.(321);
      expect(
        readFileSync(join(dir, '.release-sequence'), 'utf-8'),
        'and must write the file install.sh reads, in its format',
      ).toBe('321\n');
      expect(deps?.hostSequenceFloor?.(), 'the read port must see it').toBe(321);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
