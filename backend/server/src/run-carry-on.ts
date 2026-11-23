/** D-402 slice E4b (§6.6) — "Carry on in Chat": a run a hand-off stopped, carried on in a chat.
 *
 *  A hand-off (`RECIPE_HAND_OFF`, slice E4a) is a run that stopped because a page showed something
 *  its recipe has not met. Its notice links `#chat/carry-on/<run_id>`, and the webclient asks for
 *  this: the chat kept for the run (opened the first time) and the message its composer starts
 *  with, saying what stopped the run, in the run's own words, and to go on from that page.
 *
 *  ⛔ THE OWNER SENDS IT. Nothing here runs a turn: the owner reads the message, can say there
 *  what to do, and sends it.
 *
 *  The chat is kept with its run (`chat_run_carry_on`), for two readers: a second click on the
 *  notice opens the same chat rather than a new one, and "Make a recipe" in it (slice E4c) adds
 *  the way taken to the recipe the run was of, rather than drafting a new recipe. */
import type Database from 'better-sqlite3';
import type { RecipeError } from '@recued/contracts';

/** One chat that carries on one run. */
export interface RunCarryOn {
  readonly run_id: string;
  readonly session_id: string;
  readonly recipe_id: string;
  /** The recipe as it was when the run stopped, so slice E4c can tell an edited recipe. */
  readonly recipe_hash: string;
  /** The step that handed off, e.g. `decide_1`. */
  readonly step_id: string;
  readonly created_at: number;
}

export interface RunCarryOnStore {
  byRun(run_id: string): RunCarryOn | undefined;
  bySession(session_id: string): RunCarryOn | undefined;
  /** Keeps `row`, in place of the run's earlier chat if it had one. */
  put(row: RunCarryOn): void;
}

export const createRunCarryOnStore = (db: Database.Database): RunCarryOnStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_run_carry_on (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    recipe_hash TEXT NOT NULL,
    step_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_run_carry_on_session ON chat_run_carry_on (session_id);`);
  const byRun = db.prepare('SELECT * FROM chat_run_carry_on WHERE run_id = ?');
  // A chat carries on one run; the latest wins should a row ever name it twice.
  const bySession = db.prepare('SELECT * FROM chat_run_carry_on WHERE session_id = ? ORDER BY created_at DESC LIMIT 1');
  const put = db.prepare(`INSERT OR REPLACE INTO chat_run_carry_on
    (run_id, session_id, recipe_id, recipe_hash, step_id, created_at)
    VALUES (@run_id, @session_id, @recipe_id, @recipe_hash, @step_id, @created_at)`);
  return {
    byRun: (run_id) => byRun.get(run_id) as RunCarryOn | undefined,
    bySession: (session_id) => bySession.get(session_id) as RunCarryOn | undefined,
    put: (row) => { put.run(row); },
  };
};

/** The message the chat's composer starts with. ⚠ MODEL-FACING: the owner sends it as their own,
 *  so it reaches the chat's model (internal design notes). It quotes the run's
 *  reason as the run gave it, which for a draft the compiler made names the site and what the page
 *  showed when the job went on (slice E3b), and asks for the page as it is now before any step. */
export const carryOnDraft = (input: { readonly recipe_name?: string | undefined; readonly reason: string }): string => [
  input.recipe_name !== undefined
    ? `Carry on with “${input.recipe_name}” from where its run stopped. The run said why:`
    : 'Carry on from where this run stopped. The run said why:',
  input.reason,
  '',
  'Look at that page as it is now and tell me what it shows. If the way on is clear, go on; if not, ask me which way to take.',
].join('\n');

export type RunCarryOnResult =
  | { readonly ok: true; readonly session_id: string; readonly draft: string }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_a_hand_off'; readonly message: string };

export interface RunCarryOnDeps {
  readonly runs: {
    get(run_id: string): Promise<{ recipe_id: string; recipe_hash: string; errors?: RecipeError[] } | null | undefined>;
  };
  /** The installed recipe's name, in the owner's words; undefined when it is gone. */
  readonly recipeName: (recipe_id: string) => string | undefined;
  readonly store: RunCarryOnStore;
  readonly now: () => number;
}

/** The chat side the rpc handler supplies: whether a chat still exists, and opening one the way
 *  `chat.session.create` does (its activity row included). */
export interface RunCarryOnSessions {
  exists(session_id: string): boolean;
  create(title: string): Promise<string>;
}

export const makeRunCarryOn = (deps: RunCarryOnDeps) => {
  // Two clicks on one notice at once share one answer, so they open one chat.
  const inflight = new Map<string, Promise<RunCarryOnResult>>();
  const carryOn = async (run_id: string, sessions: RunCarryOnSessions): Promise<RunCarryOnResult> => {
    const run = await deps.runs.get(run_id);
    if (!run) {
      return { ok: false, reason: 'not_found', message: 'Recued keeps no record of this run, so there is nothing to carry on from.' };
    }
    const handOff = (run.errors ?? []).find((error) => error.code === 'RECIPE_HAND_OFF');
    const step_id = handOff?.source?.step_id;
    if (handOff === undefined || typeof step_id !== 'string' || step_id === '') {
      return { ok: false, reason: 'not_a_hand_off', message: 'This run did not stop at a page its recipe has not met, so there is nothing to carry on from.' };
    }
    const recipe_name = deps.recipeName(run.recipe_id);
    const draft = carryOnDraft({ recipe_name, reason: handOff.message });
    const kept = deps.store.byRun(run_id);
    if (kept !== undefined && sessions.exists(kept.session_id)) return { ok: true, session_id: kept.session_id, draft };
    const session_id = await sessions.create(recipe_name !== undefined ? `Carry on: ${recipe_name}` : 'Carry on a stopped run');
    deps.store.put({ run_id, session_id, recipe_id: run.recipe_id, recipe_hash: run.recipe_hash, step_id, created_at: deps.now() });
    return { ok: true, session_id, draft };
  };
  return (run_id: string, sessions: RunCarryOnSessions): Promise<RunCarryOnResult> => {
    const running = inflight.get(run_id);
    if (running !== undefined) return running;
    const answer = carryOn(run_id, sessions).finally(() => { inflight.delete(run_id); });
    inflight.set(run_id, answer);
    return answer;
  };
};
