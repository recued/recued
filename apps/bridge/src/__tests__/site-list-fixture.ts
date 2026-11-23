import { createSwMessageQueue } from '../boot/sw-message-queue.js';
import { createSiteListMessageHandler, createRuntimeSiteListMutator } from '../site-list-mutations.js';
import { createSitesControls } from '../side-panel/sites.js';
import type { SidePanelSitesState } from '../side-panel/store/local-store.js';

export const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
export const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

export const siteWorker = (initial: Record<string, unknown> = {}) => {
  const saved = structuredClone(initial);
  const reads: string[][] = [], writes: Record<string, unknown>[] = [];
  const hooks: { read?: (keys: string[]) => Promise<void>; write?: (items: Record<string, unknown>) => Promise<void> } = {};
  const storage = {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      reads.push([...keys]);
      const snapshot = Object.fromEntries(keys.filter(key => key in saved).map(key => [key, structuredClone(saved[key])]));
      await hooks.read?.(keys);
      return snapshot;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      writes.push(structuredClone(items));
      await hooks.write?.(items);
      Object.assign(saved, structuredClone(items));
    },
  };
  let handler!: (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean | undefined;
  const messages = createSwMessageQueue({
    chromeRuntimeOnMessage: { addListener(fn) { handler = fn; } },
    immediateHandler: createSiteListMessageHandler(storage),
  });
  const sent: unknown[] = [];
  const send = (message: unknown): Promise<unknown> => new Promise(resolve => {
    sent.push(message);
    const handled = handler(message, {}, resolve);
    if (handled !== true) resolve(undefined);
  });
  const panel = (dispatch = send) => {
    const states: SidePanelSitesState[] = [];
    const controls = createSitesControls({
      permissions: { contains: async () => true, request: async () => true, remove: async () => true },
      storage: { get: keys => storage.get(keys), set: async () => { throw new Error('A panel must not write settings directly'); } },
    }, state => states.push(state), createRuntimeSiteListMutator(dispatch));
    return { controls, states, last: () => states.at(-1)! };
  };
  return { saved, reads, writes, hooks, storage, send, panel, messages, sent };
};
