/** D-335 slice W3 — the browser flows the owner kept: the steps a chat turn did in their browser,
 *  kept when they answered "That was right" to the "Worth remembering?" ask, and listed in Settings →
 *  Privacy → Learning beside the cases, to make a recipe of later (W4).
 *
 *  ⛔ **ITS OWN TABLE, BECAUSE A CASE ROW IS A PROJECTION.** `execution_cases` is re-derived from its
 *  sources on every compile, so an entry written into it would be wiped by the next rebuild, and a
 *  case holds tool names without their arguments, where a flow is its arguments: the page, the
 *  element and what was typed (`execution-case-authored-store.ts` keeps its links apart for the same
 *  reason).
 *
 *  ⛔ **SEALED, AS THE D-214 TABLES ARE.** A flow holds what was typed and the addresses it was typed
 *  on, so its payload is sealed under the chat sub-DEK (`d214-sealed-json.ts`); a locked vault keeps
 *  nothing rather than keeping it raw. What a field for a password, a sign-in code or a card took is
 *  never in it (`browser-flow-record.ts`).
 *
 *  ⚠ No explicit index: the D-214 ratchet allows none on an `execution_case` table but the primary
 *  key's own. It joins the privacy cascade: deleting a chat session deletes the flows it kept. */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { BrowserFlowStep } from '../bridges/browser-flow-record.js';
import { D214VaultLockedError, openD214Json, sealD214Json, type D214KeyProvider } from './d214-sealed-json.js';

export interface KeptBrowserFlow {
  flow_id: string;
  session_id: string;
  /** The request the steps answered, as the offer named it. */
  root_request_id: string;
  kept_at: number;
  steps: BrowserFlowStep[];
}

export interface BrowserFlowStore {
  /** Keep a flow; its id, or `undefined` when the vault is locked (nothing is kept raw). */
  keep(input: Omit<KeptBrowserFlow, 'flow_id'>): Promise<string | undefined>;
  /** Every kept flow, newest first. A flow the vault cannot open now is left out. */
  list(): Promise<KeptBrowserFlow[]>;
  get(flow_id: string): Promise<KeptBrowserFlow | undefined>;
  /** Forget one; whether there was one. */
  forget(flow_id: string): boolean;
  /** The privacy cascade: every flow a chat session kept. */
  deleteForSession(session_id: string): number;
}

const DOMAIN = 'browser_flow';

export const ensureExecutionCaseBrowserFlowSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_case_browser_flows (
      flow_id           TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      root_request_id   TEXT NOT NULL,
      kept_at           INTEGER NOT NULL,
      payload_encrypted TEXT NOT NULL
    );
  `);
};

interface FlowRow {
  flow_id: string;
  session_id: string;
  root_request_id: string;
  kept_at: number;
  payload_encrypted: string;
}

export const createExecutionCaseBrowserFlowStore = (
  db: Database.Database,
  keyProvider?: D214KeyProvider,
): BrowserFlowStore => {
  ensureExecutionCaseBrowserFlowSchema(db);
  const insert = db.prepare(`
    INSERT INTO execution_case_browser_flows (flow_id, session_id, root_request_id, kept_at, payload_encrypted)
    VALUES (@flow_id, @session_id, @root_request_id, @kept_at, @payload_encrypted)
  `);
  const selectAll = db.prepare('SELECT * FROM execution_case_browser_flows ORDER BY kept_at DESC, flow_id ASC');
  const selectOne = db.prepare('SELECT * FROM execution_case_browser_flows WHERE flow_id = ?');
  const removeOne = db.prepare('DELETE FROM execution_case_browser_flows WHERE flow_id = ?');
  const removeForSession = db.prepare('DELETE FROM execution_case_browser_flows WHERE session_id = ?');
  const open = async (row: FlowRow): Promise<KeptBrowserFlow | undefined> => {
    try {
      const steps = await openD214Json<BrowserFlowStep[]>(row.payload_encrypted, DOMAIN, row.flow_id, keyProvider);
      return { flow_id: row.flow_id, session_id: row.session_id, root_request_id: row.root_request_id, kept_at: row.kept_at, steps };
    } catch (error) {
      if (error instanceof D214VaultLockedError) return undefined;
      throw error;
    }
  };
  return {
    async keep(input) {
      const flow_id = randomUUID();
      let payload_encrypted: string;
      try {
        payload_encrypted = await sealD214Json(input.steps, DOMAIN, flow_id, keyProvider);
      } catch (error) {
        if (error instanceof D214VaultLockedError) return undefined;
        throw error;
      }
      insert.run({ flow_id, session_id: input.session_id, root_request_id: input.root_request_id, kept_at: input.kept_at,
        payload_encrypted });
      return flow_id;
    },
    async list() {
      const flows = await Promise.all((selectAll.all() as FlowRow[]).map(open));
      return flows.filter((flow): flow is KeptBrowserFlow => flow !== undefined);
    },
    async get(flow_id) {
      const row = selectOne.get(flow_id) as FlowRow | undefined;
      return row === undefined ? undefined : open(row);
    },
    forget(flow_id) {
      return removeOne.run(flow_id).changes > 0;
    },
    deleteForSession(session_id) {
      return removeForSession.run(session_id).changes;
    },
  };
};
