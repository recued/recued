import { BLOCKED_SITES_KEY, BLOCKED_SITES_MAX, normalizeBlockedSite, readBlockedSites } from './permissions/site-grants.js';
import { KEEP_SIGNED_IN_KEY, KEEP_SIGNED_IN_MAX_SITES, keepSignedInSiteOf, readKeepSignedIn,
  type KeepSignedInSite } from './keep-signed-in.js';
import { runSiteListMutation } from './site-list-queue.js';

export const SITE_LIST_EDIT_MESSAGE_TYPE = 'recued.bridge.side-panel.site-list-edit';

export interface SiteListStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type SiteListEdit =
  | { list: 'blocked'; op: 'add'; site: string }
  | { list: 'blocked'; op: 'remove'; site: string }
  | { list: 'blocked'; op: 'restore'; site: string; index: number }
  | { list: 'keep'; op: 'add'; entry: KeepSignedInSite }
  | { list: 'keep'; op: 'remove'; site: string }
  | { list: 'keep'; op: 'restore'; entry: KeepSignedInSite; index: number };

export type SiteListMutationResult =
  | { ok: true; written: boolean; removed?: { site: string; index: number; entry?: KeepSignedInSite } }
  | { ok: false; error: 'invalid' | 'read_failed' | 'save_failed' | 'full' | 'unconfirmed' };

export type SiteListMutator = (edit: SiteListEdit) => Promise<SiteListMutationResult>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const indexOf = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const parseSiteListEdit = (value: unknown): SiteListEdit | null => {
  if (!record(value) || (value.list !== 'blocked' && value.list !== 'keep')
    || typeof value.op !== 'string' || !['add', 'remove', 'restore'].includes(value.op)) return null;
  if (value.op === 'restore' && !indexOf(value.index)) return null;
  if (value.list === 'keep' && (value.op === 'add' || value.op === 'restore')) {
    const entry = keepSignedInSiteOf(value.entry);
    if (entry === null) return null;
    return value.op === 'add' ? { list: 'keep', op: 'add', entry }
      : { list: 'keep', op: 'restore', entry, index: value.index as number };
  }
  const site = typeof value.site === 'string' ? normalizeBlockedSite(value.site) : null;
  if (site === null) return null;
  if (value.list === 'keep') return value.op === 'remove' ? { list: 'keep', op: 'remove', site } : null;
  if (value.op === 'restore') return { list: 'blocked', op: 'restore', site, index: value.index as number };
  return value.op === 'add' || value.op === 'remove' ? { list: 'blocked', op: value.op, site } : null;
};

const putBack = <T>(list: readonly T[], item: T, index: number): T[] =>
  [...list.slice(0, index), item, ...list.slice(index)];

/** One current read and its write share the worker queue. Removal metadata
 * comes from that read, so Undo never invents a removed entry from panel state. */
export const createSiteListMutator = (storage: SiteListStorage): SiteListMutator => async request => {
  const edit = parseSiteListEdit(request);
  if (edit === null) return { ok: false, error: 'invalid' };
  return runSiteListMutation(async (): Promise<SiteListMutationResult> => {
    const key = edit.list === 'blocked' ? BLOCKED_SITES_KEY : KEEP_SIGNED_IN_KEY;
    let snapshot: Record<string, unknown>;
    try { snapshot = await storage.get([key]); }
    catch { return { ok: false, error: 'read_failed' }; }
    let next: string[] | KeepSignedInSite[];
    let removed: Extract<SiteListMutationResult, { ok: true }>['removed'];
    if (edit.list === 'blocked') {
      // Preserve the existing repair of malformed data after a successful read.
      const list = await readBlockedSites({ get: async () => snapshot }).catch((): string[] => []);
      const index = list.indexOf(edit.site);
      if (edit.op === 'remove') {
        next = list.filter(site => site !== edit.site);
        if (index >= 0) removed = { site: edit.site, index };
      } else {
        if (index >= 0) return { ok: true, written: false };
        if (list.length >= BLOCKED_SITES_MAX) return { ok: false, error: 'full' };
        next = edit.op === 'add' ? [...list, edit.site] : putBack(list, edit.site, edit.index);
      }
    } else {
      const list = readKeepSignedIn(snapshot[key]);
      if (edit.op === 'remove') {
        const index = list.findIndex(entry => entry.site === edit.site);
        next = list.filter(entry => entry.site !== edit.site);
        if (index >= 0) removed = { site: edit.site, index, entry: list[index]! };
      } else {
        if (edit.op === 'restore' && list.some(entry => entry.site === edit.entry.site)) return { ok: true, written: false };
        const others = edit.op === 'add' ? list.filter(entry => entry.site !== edit.entry.site) : list;
        if (others.length >= KEEP_SIGNED_IN_MAX_SITES) return { ok: false, error: 'full' };
        next = edit.op === 'add' ? [...others, edit.entry] : putBack(others, edit.entry, edit.index);
      }
    }
    try { await storage.set({ [key]: next }); }
    catch { return { ok: false, error: 'save_failed' }; }
    return { ok: true, written: true, ...(removed ? { removed } : {}) };
  });
};

/** This local settings responder runs even while server boot is pending or failed. */
export const createSiteListMessageHandler = (storage: SiteListStorage | undefined) => {
  if (!storage) return undefined;
  const mutate = createSiteListMutator(storage);
  return (message: unknown, _sender: unknown, sendResponse: (reply: unknown) => void): true | undefined => {
    if (!record(message) || message.type !== SITE_LIST_EDIT_MESSAGE_TYPE) return undefined;
    const respond = (reply: SiteListMutationResult): void => {
      try { sendResponse(reply); } catch { /* The owning panel may have closed. */ }
    };
    const edit = parseSiteListEdit(message.edit);
    if (edit === null) respond({ ok: false, error: 'invalid' });
    else void mutate(edit).then(respond, () => respond({ ok: false, error: 'unconfirmed' }));
    return true;
  };
};

/** A lost reply cannot establish whether the worker committed the change. */
export const createRuntimeSiteListMutator = (send: (message: unknown) => Promise<unknown>): SiteListMutator => async edit => {
  let reply: unknown;
  try { reply = await send({ type: SITE_LIST_EDIT_MESSAGE_TYPE, edit }); }
  catch { return { ok: false, error: 'unconfirmed' }; }
  if (!record(reply)) return { ok: false, error: 'unconfirmed' };
  if (reply.ok === false && typeof reply.error === 'string' && ['invalid', 'read_failed', 'save_failed', 'full', 'unconfirmed'].includes(reply.error)) {
    return { ok: false, error: reply.error as Extract<SiteListMutationResult, { ok: false }>['error'] };
  }
  if (reply.ok !== true || typeof reply.written !== 'boolean') return { ok: false, error: 'unconfirmed' };
  if (reply.removed === undefined) return { ok: true, written: reply.written };
  const removed = reply.removed;
  if (!reply.written || !record(removed) || typeof removed.site !== 'string'
    || normalizeBlockedSite(removed.site) !== removed.site || !indexOf(removed.index)) return { ok: false, error: 'unconfirmed' };
  if (edit.op !== 'remove' || removed.site !== normalizeBlockedSite(edit.site)) return { ok: false, error: 'unconfirmed' };
  if (edit.list === 'blocked') return { ok: true, written: true, removed: { site: removed.site, index: removed.index } };
  const entry = keepSignedInSiteOf(removed.entry);
  if (!entry || entry.site !== removed.site) return { ok: false, error: 'unconfirmed' };
  return { ok: true, written: true, removed: { site: removed.site, index: removed.index, entry } };
};
