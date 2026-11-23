import type { PickerResultMessage } from './picker-protocol.js';

export const PICKER_SESSION_TTL_MS = 5 * 60_000;
export interface PickerDocument {
  tab_id: number;
  document_id: string;
  page_url: string;
}
export interface PickerLaunch<Owner> {
  readonly launch_id: string;
  readonly expires_at: number;
  readonly owner: Owner;
  document: PickerDocument | null;
  consumed: boolean;
}

/** One pending or consumed launch per worker. Consuming happens before the
 * first RPC await; retaining its identity also fences late confirmations. */
export const createPickerSessions = <Owner,>(now: () => number) => {
  let current: PickerLaunch<Owner> | null = null;
  const owns = (launch: PickerLaunch<Owner>, owner: Owner | null): boolean =>
    current === launch && owner !== null && launch.owner === owner;
  return {
    begin(owner: Owner): PickerLaunch<Owner> {
      current = { launch_id: crypto.randomUUID(), expires_at: now() + PICKER_SESSION_TTL_MS,
        owner, document: null, consumed: false };
      return current;
    },
    current: owns,
    bind(launch: PickerLaunch<Owner>, owner: Owner | null, document: PickerDocument): boolean {
      if (!owns(launch, owner) || now() >= launch.expires_at) return false;
      launch.document = document;
      return true;
    },
    retire(launch?: PickerLaunch<Owner>): void {
      if (launch === undefined || current === launch) current = null;
    },
    retireTab(tab_id: number): void {
      // Until injection identifies a document, navigation retires the
      // unresolved launch too. There is never more than one to retire.
      if (current && (current.document === null || current.document.tab_id === tab_id)) current = null;
    },
    consume(message: PickerResultMessage, sender: unknown, owner: Owner | null):
      | { ok: true; launch: PickerLaunch<Owner> }
      | { ok: false; error: string; expired?: PickerLaunch<Owner> } {
      const launch = current;
      const source = sender as { tab?: { id?: unknown }; frameId?: unknown; documentId?: unknown; url?: unknown } | null;
      const doc = launch?.document;
      if (!launch || !owns(launch, owner) || launch.consumed || message.launch_id !== launch.launch_id
        || !doc || source?.tab?.id !== doc.tab_id || source.frameId !== 0
        || source.documentId !== doc.document_id || source.url !== doc.page_url
        || (message.result.status === 'picked' && message.result.page_url !== doc.page_url)) {
        return { ok: false, error: 'picker_session_invalid' };
      }
      if (now() >= launch.expires_at) {
        current = null;
        return { ok: false, error: 'picker_session_expired', expired: launch };
      }
      launch.consumed = true;
      return { ok: true, launch };
    },
  };
};
