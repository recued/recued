/** `recued unlock` — the recovery key over `/auth/pair`, against the REAL route.
 *
 *  ⛔ WHY THIS EXISTS. The command used to send `auth.unlock` over the rpc
 *  socket with the raw realm token, which the server has refused with a 401
 *  since `89ba9bb31` — so on every release from 26.8.1 it never reached the
 *  server (measured on the published 26.10.6 against a locked realm, together
 *  with `--recovery-key`, the disaster-recovery form). No test drove the CLI
 *  against a server, so nothing noticed.
 *
 *  These drive `unlockWithRecoveryKey` against a real `startServer`, not a
 *  stub: the route's own answers (200, `recovery_key_invalid`, "code is
 *  required") are what the CLI's lines are keyed on, and a stub would only
 *  prove the CLI agrees with itself. That the same request unlocks a locked
 *  vault was measured live (2026-10-07) — this harness wires no key manager. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createServer as createNetServer } from 'node:net';
import { generateRecoveryKey } from '@recued/crypto';
import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createPairingManager } from '../pairing.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import { unlockWithRecoveryKey } from '../commands/auth.js';

/** The real fetch, recording what the CLI sent. */
const recordingFetch = () => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return fetch(url, init);
  }) as typeof fetch;
  return { impl, sent };
};

describe('recued unlock — an enrolled server', () => {
  let server: RunningServer;
  let db: Database.Database;
  let pairedInstances: ReturnType<typeof createPairedInstancesStore>;
  const realmRecoveryKey = generateRecoveryKey().mnemonic;

  beforeAll(async () => {
    db = new Database(':memory:');
    const recoveryKeyCheck = createRecoveryKeyCheckStore(db);
    const { processRecoveryKey } = await import('../recovery-key-processor.js');
    await processRecoveryKey(recoveryKeyCheck, realmRecoveryKey);
    pairedInstances = createPairedInstancesStore(db);
    server = await startServer(0, {
      executeDeps: {
        recipeStore: createRecipeStore('/nonexistent'),
        executorConfig: { manifests: createManifestRegistry('/nonexistent') },
        baseVault: {},
      },
      pairing: createPairingManager({ realmToken: 'unlock-realm' }),
      recoveryKeyCheck,
      pairedInstances,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('unlocks with the recovery key — and adds no device to the roster', async () => {
    const { impl, sent } = recordingFetch();
    const outcome = await unlockWithRecoveryKey({ port: server.port, recoveryKey: realmRecoveryKey, fetchImpl: impl });
    expect(outcome).toEqual({ ok: true, line: '  ✓ Unlocked.' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`http://127.0.0.1:${server.port}/auth/pair`);
    // The recovery key IS the credential; no instanceId means no Devices row.
    expect(sent[0]!.body).toEqual({ recoveryKey: realmRecoveryKey, clientKind: 'cli', displayName: 'recued unlock' });
    expect(pairedInstances.listAllActive()).toEqual([]);
  });

  it('takes the key as piped — surrounding whitespace and the newline are not part of it', async () => {
    const outcome = await unlockWithRecoveryKey({ port: server.port, recoveryKey: `  ${realmRecoveryKey}\n` });
    expect(outcome.ok).toBe(true);
  });

  it('says a wrong key does not match — the route answers recovery_key_invalid', async () => {
    const wrong = generateRecoveryKey().mnemonic;
    const outcome = await unlockWithRecoveryKey({ port: server.port, recoveryKey: wrong });
    expect(outcome).toEqual({ ok: false, line: '  ✗ That recovery key does not match this server.' });
  });

  it('sends nothing for an empty key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = await unlockWithRecoveryKey({ port: server.port, recoveryKey: '   \n', fetchImpl });
    expect(outcome).toEqual({ ok: false, line: '  ✗ No recovery key entered.' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('recued unlock — a server that was never paired', () => {
  let server: RunningServer;
  let db: Database.Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    server = await startServer(0, {
      executeDeps: {
        recipeStore: createRecipeStore('/nonexistent'),
        executorConfig: { manifests: createManifestRegistry('/nonexistent') },
        baseVault: {},
      },
      pairing: createPairingManager({ realmToken: 'fresh-realm' }),
      // Wired but never enrolled.
      recoveryKeyCheck: createRecoveryKeyCheckStore(db),
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('says it has no recovery key yet, and how to give it one', async () => {
    const outcome = await unlockWithRecoveryKey({ port: server.port, recoveryKey: generateRecoveryKey().mnemonic });
    expect(outcome.ok).toBe(false);
    expect(outcome.line).toMatch(/never been paired/);
    expect(outcome.line).toMatch(/recued pair/);
  });
});

describe('recued unlock — nothing listening', () => {
  it('names the port, and the passphrase case that keeps a server from starting', async () => {
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const outcome = await unlockWithRecoveryKey({ port, recoveryKey: generateRecoveryKey().mnemonic });
    expect(outcome.ok).toBe(false);
    expect(outcome.line).toContain(`127.0.0.1:${port}`);
    expect(outcome.line).toContain('RECUED_IDENTITY_PASSPHRASE');
  });
});

describe('the encryption commands that are left', () => {
  // `auth-status` and `lock` were retired 2026-10-07: the server refused both
  // (401) on every release from 26.8.1, and the CLI holds no other credential.
  it('help lists unlock, and neither retired command', async () => {
    const { cmdHelp } = await import('../commands/help.js');
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.join(' ')); });
    try {
      cmdHelp('test');
    } finally {
      spy.mockRestore();
    }
    const help = out.join('\n');
    expect(help).toMatch(/^\s+unlock\s+Unlock a running server with its 24-word recovery key$/m);
    expect(help).not.toMatch(/^\s+auth-status\s/m);
    expect(help).not.toMatch(/^\s+lock\s/m);
  });

  it('the retired names say what to use instead', async () => {
    const { retiredEncryptionCommandLines } = await import('../commands/auth.js');
    expect(retiredEncryptionCommandLines('auth-status').join('\n')).toContain('Settings → Server → Key Health');
    expect(retiredEncryptionCommandLines('lock').join('\n')).toContain('recued stop');
  });
});
