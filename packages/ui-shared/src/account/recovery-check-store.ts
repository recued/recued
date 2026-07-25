/** Persistence for a local `recovery_key_check` blob.
 *
 *  The check is a ~60-byte AEAD seal over a public sentinel
 *  (`buildRecoveryKeyCheck`). Storing it lets the surface (webclient,
 *  bridge):
 *    - Know whether the user has set up a recovery key (gate / banner)
 *    - Verify a user-typed key matches the one they originally set
 *      (without ever storing the key itself)
 *    - Hand the same blob to a paired server — the wire shape is the
 *      same on every surface.
 *
 *  The key itself is never persisted. Only the check blob is.
 *
 *  Lifted from the extension's `recovery/store.ts` at `c222acac^`; the
 *  chrome-storage default was dropped in favor of an in-memory default
 *  since ui-shared has no platform-specific storage. Hosts wire their
 *  own `RecoveryCheckStorage` (chrome.storage in the bridge, IndexedDB
 *  + IDB-backed kv in the webclient, etc.). */

export interface RecoveryCheckStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const RECOVERY_CHECK_KEY = 'recued.recovery.check';

/** Read the persisted check blob, or null when no recovery key has
 *  been set up on this device yet. Never throws — a corrupt / missing
 *  key is indistinguishable from "not set up", and the recovery of
 *  that is the setup flow itself. */
export const readRecoveryCheck = async (
  storage: RecoveryCheckStorage,
): Promise<string | null> => {
  try {
    const data = await storage.get([RECOVERY_CHECK_KEY]);
    const value = data[RECOVERY_CHECK_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/** True when a recovery key is enrolled on this device. Cheap boolean
 *  form of `readRecoveryCheck` — used by callers to decide whether
 *  to prompt setup vs entry. */
export const hasRecoveryCheck = async (
  storage: RecoveryCheckStorage,
): Promise<boolean> => {
  return (await readRecoveryCheck(storage)) !== null;
};

/** Persist the check blob. Callers should have just derived the KEK
 *  from the user's key and verified the blob with `verifyRecoveryKeyCheck`
 *  to catch silent corruption before storing. */
export const writeRecoveryCheck = async (
  storage: RecoveryCheckStorage,
  checkBlob: string,
): Promise<void> => {
  await storage.set({ [RECOVERY_CHECK_KEY]: checkBlob });
};

/** Clear the stored check. Used on factory reset / account wipe /
 *  explicit "forget recovery key" action. Idempotent. */
export const clearRecoveryCheck = async (
  storage: RecoveryCheckStorage,
): Promise<void> => {
  await storage.remove([RECOVERY_CHECK_KEY]);
};

/** In-memory storage — used when no host-supplied storage is wired,
 *  and as the default in tests that don't care about cross-page
 *  persistence. Won't survive a page reload; hosts that need that
 *  wire IndexedDB / chrome.storage / equivalent. */
export const createInMemoryRecoveryStorage = (): RecoveryCheckStorage => {
  const mem = new Map<string, unknown>();
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (mem.has(k)) out[k] = mem.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) mem.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) mem.delete(k);
    },
  };
};
