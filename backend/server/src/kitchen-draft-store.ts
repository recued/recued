import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  KITCHEN_COMPILED_ORIGIN_PREFIX, KITCHEN_DRAFT_MAX_COUNT, KITCHEN_DRAFT_MAX_NOTES, KITCHEN_DRAFT_NOTE_MAX_CHARS,
  KITCHEN_DRAFT_SOURCE_MAX_BYTES, KITCHEN_OWNER_ORIGIN, KITCHEN_WORK_LIST_MAX,
  kitchenDraftPath, RpcError, STDIO_MCP_TOKEN_ID,
  type KitchenDraftDiscardResult, type KitchenDraftImportInput, type KitchenDraftImportReceipt,
  type KitchenDraftMadeFrom, type KitchenDraftValidation, type KitchenImportDraft, type KitchenDraftSummary,
  type KitchenWorkBase, type KitchenWorkItem,
} from '@recued/contracts';
import { validateRecipe } from '@recued/recipes';
import { validateAuthoringSource } from '@recued/ingredient-authoring';

const sha = (source: string): string => createHash('sha256').update(source).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const bad = (message: string): never => { throw new RpcError('bad_request', message, 400); };

export const parseKitchenDraftImport = (value: unknown): KitchenDraftImportInput => {
  if (!object(value)) return bad('Provide a recipe or pack import.');
  if (Object.keys(value).some(key => !['kind', 'source', 'request_id', 'title'].includes(key))) {
    return bad('An import accepts kind, source, request_id and an optional title.');
  }
  if (value.kind !== 'recipe' && value.kind !== 'pack') return bad('Choose kind recipe or pack.');
  if (typeof value.source !== 'string' || !value.source.trim()
    || Buffer.byteLength(value.source, 'utf8') > KITCHEN_DRAFT_SOURCE_MAX_BYTES) {
    return bad(`Provide JSON source of at most ${KITCHEN_DRAFT_SOURCE_MAX_BYTES} bytes, not a file path or URL.`);
  }
  if (typeof value.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.request_id)) {
    return bad('Provide a request_id of 1–128 letters, numbers, underscores or hyphens.');
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200)) {
    return bad('A draft title must contain 1–200 characters.');
  }
  return { kind: value.kind, source: value.source, request_id: value.request_id,
    ...(typeof value.title === 'string' ? { title: value.title.trim() } : {}) };
};

export const validateKitchenDraftSource = (kind: KitchenImportDraft['kind'], source: string): KitchenDraftValidation =>
  validateAuthoringSource(kind, source, validateRecipe);

/** D-333 — the name the source gives itself (a recipe's `metadata.name`, a pack's `name`), so
 *  In progress shows what is being written rather than how it arrived. */
const sourceName = (kind: KitchenImportDraft['kind'], source: string): string | undefined => {
  try {
    const body = JSON.parse(source) as Record<string, unknown> | null;
    const name = kind === 'recipe' ? (body?.metadata as { name?: unknown } | undefined)?.name : body?.name;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : undefined;
  } catch { return undefined; }
};

/** Who started an item, in words that follow "From". `tokenLabel` names an MCP connection by
 *  its key's label, which keeps its own case. */
export const describeKitchenDraftOrigin = (origin: string, tokenLabel?: (tokenId: string) => string | undefined): string => {
  if (origin === KITCHEN_OWNER_ORIGIN) return 'Kitchen';
  // D-402 slice A3 — a draft Recued compiled from a chat request, or from an AI app's job.
  if (origin === `${KITCHEN_COMPILED_ORIGIN_PREFIX}chat`) return 'your chat';
  if (origin.startsWith(`${KITCHEN_COMPILED_ORIGIN_PREFIX}job:`)) {
    const token = origin.slice(`${KITCHEN_COMPILED_ORIGIN_PREFIX}job:`.length);
    return token === STDIO_MCP_TOKEN_ID ? 'a local AI app' : tokenLabel?.(token)?.trim() || 'an AI app';
  }
  if (origin === `mcp:${STDIO_MCP_TOKEN_ID}`) return 'a local AI app';
  if (origin.startsWith('mcp:')) return tokenLabel?.(origin.slice('mcp:'.length))?.trim() || 'an AI app';
  return origin.startsWith('source:chat:') ? 'your chat' : 'a recipe';
};
const GONE = 'This is no longer in progress in Kitchen.';

interface Row {
  draft_id: string; kind: 'recipe' | 'pack'; title: string; source: string; source_hash: string;
  request_hash: string; revision: number; created_at: number; updated_at: number; receipt_json?: string;
  base_recipe_id?: string | null; base_version?: number | null;
  notes_json?: string | null; made_from_json?: string | null;
}
const baseOf = (row: Row): { base?: KitchenWorkBase } =>
  row.base_recipe_id ? { base: { recipe_id: row.base_recipe_id, version: row.base_version ?? 1 } } : {};
/** D-402 slice A3 — a compiled draft's notes and what it was made from; a row written before
 *  either existed, or one whose JSON no longer reads, simply has none. */
const compiledOf = (row: Row): { notes?: string[]; made_from?: KitchenDraftMadeFrom } => {
  const read = (json: string | null | undefined): unknown => {
    if (!json) return undefined;
    try { return JSON.parse(json) as unknown; } catch { return undefined; }
  };
  const notes = read(row.notes_json);
  const made_from = read(row.made_from_json);
  return {
    ...(Array.isArray(notes) && notes.every((note) => typeof note === 'string') ? { notes: notes as string[] } : {}),
    ...(object(made_from) && (made_from.kind === 'chat_request' || made_from.kind === 'ai_app_job')
      ? { made_from: made_from as unknown as KitchenDraftMadeFrom } : {}),
  };
};
const draft = (row: Row): KitchenImportDraft => ({ draft_id: row.draft_id, kind: row.kind,
  title: row.title, source: row.source, source_hash: row.source_hash, revision: row.revision,
  created_at: row.created_at, updated_at: row.updated_at,
  validation: validateKitchenDraftSource(row.kind, row.source), ...baseOf(row), ...compiledOf(row) });
const receipt = (row: Row, replayed: boolean): KitchenDraftImportReceipt => {
  const { source: _source, ...view } = draft(row);
  return { ...view, replayed, kitchen_path: kitchenDraftPath(row.draft_id), installed: false };
};

export interface KitchenDraftStore {
  check(origin: string, raw: unknown): void;
  import(origin: string, raw: unknown): KitchenDraftImportReceipt;
  list(origin: string): KitchenDraftSummary[];
  get(id: string, origin?: string): KitchenImportDraft | null;
  update(id: string, revision: number, source: string, origin?: string): KitchenImportDraft;
  /** Owner only: removes the draft and its source, if `revision` is still current. */
  discard(id: string, revision: number): KitchenDraftDiscardResult;
  /** Owner only (D-333): In progress, every origin, newest first, without source. */
  listAll(): KitchenWorkItem[];
  /** Owner only (D-333): start new work under the owner's own origin. */
  /** `base`: changes to that saved recipe, kept as one item; a second is a conflict. */
  create(kind: KitchenImportDraft['kind'], source: string, base?: KitchenWorkBase): KitchenImportDraft;
  /** D-402 slice A3 — a draft Recued compiled, under its own origin (`recued:chat`,
   *  `recued:job:<token>`), with its notes and what it was made from. The import path's size,
   *  validation and per-origin limit apply. Slice E4c — `base`: changes to that saved recipe, which
   *  Kitchen continues on the recipe itself; a second item for it, of any origin, is a conflict. */
  createCompiled(input: { origin: string; kind: KitchenImportDraft['kind']; source: string; title?: string;
    notes: readonly string[]; made_from: KitchenDraftMadeFrom; base?: KitchenWorkBase }): KitchenImportDraft;
}
export const createKitchenDraftStore = (
  db: Database.Database,
  now: () => number = Date.now,
  describeOrigin: (origin: string) => string = (origin) => describeKitchenDraftOrigin(origin),
): KitchenDraftStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS kitchen_import_draft (
    draft_id TEXT PRIMARY KEY, origin TEXT NOT NULL, request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    source TEXT NOT NULL, source_hash TEXT NOT NULL, revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, receipt_json TEXT NOT NULL,
    UNIQUE(origin, request_id)
  )`);
  // D-333 — changes to a saved recipe name the recipe and the version they began from.
  const columns = db.prepare('PRAGMA table_info(kitchen_import_draft)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'base_recipe_id')) {
    db.exec(`ALTER TABLE kitchen_import_draft ADD COLUMN base_recipe_id TEXT;
      ALTER TABLE kitchen_import_draft ADD COLUMN base_version INTEGER`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS kitchen_import_draft_base
    ON kitchen_import_draft (origin, base_recipe_id) WHERE base_recipe_id IS NOT NULL`);
  // D-402 slice A3 — a compiled draft's notes and what it was made from.
  if (!columns.some((column) => column.name === 'notes_json')) {
    db.exec(`ALTER TABLE kitchen_import_draft ADD COLUMN notes_json TEXT;
      ALTER TABLE kitchen_import_draft ADD COLUMN made_from_json TEXT`);
  }
  const check = (origin: string, raw: unknown): { input: KitchenDraftImportInput; hash: string; existing?: Row } => {
    const input = parseKitchenDraftImport(raw);
    if (!origin) throw new RpcError('unauthorized', 'An authenticated author is required.', 401);
    const hash = sha(JSON.stringify(input));
    const existing = db.prepare('SELECT * FROM kitchen_import_draft WHERE origin = ? AND request_id = ?')
      .get(origin, input.request_id) as Row | undefined;
    if (existing && existing.request_hash !== hash) throw new RpcError('conflict',
      'This request_id already imported different source. Use a new request_id for a new import.', 409);
    if (existing) return { input, hash, existing };
    // ⛔ PER CALLER (D-332). Counted across every caller, the first 100 imports
    // from anyone ended importing for everyone, and no caller could free a slot.
    const { n } = db.prepare('SELECT count(*) AS n FROM kitchen_import_draft WHERE origin = ?').get(origin) as { n: number };
    if (n >= KITCHEN_DRAFT_MAX_COUNT) throw new RpcError('resource_exhausted', origin === KITCHEN_OWNER_ORIGIN
      ? `Kitchen already has ${KITCHEN_DRAFT_MAX_COUNT} things in progress. Finish or discard some, then start again.`
      : `This connection already has ${KITCHEN_DRAFT_MAX_COUNT} things in progress in Kitchen. Discard some there, then hand over more.`, 429);
    return { input, hash };
  };
  const importDraft = db.transaction((origin: string, raw: unknown): KitchenDraftImportReceipt => {
    const { input, hash, existing } = check(origin, raw);
    if (existing) return { ...JSON.parse(existing.receipt_json!) as KitchenDraftImportReceipt, replayed: true };
    const at = now();
    const row: Row = { draft_id: randomUUID(), kind: input.kind,
      title: input.title ?? `Imported ${input.kind}`, source: input.source, source_hash: sha(input.source),
      request_hash: hash, revision: 1, created_at: at, updated_at: at };
    // Validate before persistence, without resolving dependencies or calling providers.
    const result = receipt(row, false);
    db.prepare(`INSERT INTO kitchen_import_draft
      (draft_id, origin, request_id, request_hash, kind, title, source, source_hash, revision, created_at, updated_at, receipt_json)
      VALUES (@draft_id, @origin, @request_id, @request_hash, @kind, @title, @source, @source_hash, @revision, @created_at, @updated_at, @receipt_json)`)
      .run({ ...row, origin, request_id: input.request_id, receipt_json: JSON.stringify(result) });
    return result;
  }).immediate;
  const getDraft = (id: string, origin?: string): KitchenImportDraft | null => {
    const row = db.prepare('SELECT * FROM kitchen_import_draft WHERE draft_id = ? AND (? IS NULL OR origin = ?)')
      .get(id, origin ?? null, origin ?? null) as Row | undefined;
    return row ? draft(row) : null;
  };
  return {
    check(origin: string, raw: unknown): void { check(origin, raw); },
    import: importDraft,
    list(origin: string): KitchenDraftSummary[] {
      return db.prepare<[string, number], KitchenDraftSummary>(`SELECT draft_id, kind, title, source_hash, revision, created_at, updated_at
        FROM kitchen_import_draft WHERE origin = ? ORDER BY updated_at DESC, draft_id LIMIT ?`).all(origin, KITCHEN_DRAFT_MAX_COUNT);
    },
    get: getDraft,
    update: db.transaction((id: string, revision: number, source: string, origin?: string): KitchenImportDraft => {
      if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > KITCHEN_DRAFT_SOURCE_MAX_BYTES) {
        return bad('Provide draft source within the import size limit.');
      }
      const row = db.prepare('SELECT * FROM kitchen_import_draft WHERE draft_id = ? AND (? IS NULL OR origin = ?)')
        .get(id, origin ?? null, origin ?? null) as Row | undefined;
      if (!row) throw new RpcError('not_found', GONE, 404);
      if (row.revision !== revision) throw new RpcError('conflict', 'This changed since you opened it. Reopen it to continue.', 409);
      // D-333 — the title follows the name the source gives itself, once it has one.
      const updated = { ...row, source, source_hash: sha(source), revision: revision + 1, updated_at: now(),
        title: sourceName(row.kind, source) ?? row.title };
      const result = draft(updated);
      db.prepare('UPDATE kitchen_import_draft SET source = ?, source_hash = ?, title = ?, revision = revision + 1, updated_at = ? WHERE draft_id = ?')
        .run(updated.source, updated.source_hash, updated.title, updated.updated_at, id);
      return result;
    }).immediate,
    // Deletes the row outright: a later call naming the draft finds nothing (`not_found`).
    // A re-sent import of the same request_id makes a new draft, which can be discarded too.
    discard: db.transaction((id: string, revision: number): KitchenDraftDiscardResult => {
      const row = db.prepare('SELECT revision FROM kitchen_import_draft WHERE draft_id = ?')
        .get(id) as { revision: number } | undefined;
      if (!row) throw new RpcError('not_found', GONE, 404);
      // The same revision rule as a save: never discard edits made since the owner read it.
      if (row.revision !== revision) throw new RpcError('conflict', 'This changed since you opened it. Reopen it before discarding.', 409);
      db.prepare('DELETE FROM kitchen_import_draft WHERE draft_id = ?').run(id);
      return { draft_id: id, discarded: true };
    }).immediate,
    listAll(): KitchenWorkItem[] {
      const rows = db.prepare(`SELECT * FROM kitchen_import_draft ORDER BY updated_at DESC, draft_id LIMIT ?`)
        .all(KITCHEN_WORK_LIST_MAX) as Array<Row & { origin: string }>;
      return rows.map((row) => {
        // Measured 2026-10-28: ~5 ms for a 530 KB pack, 0.2 ms for a recipe.
        const validation = validateKitchenDraftSource(row.kind, row.source);
        return { draft_id: row.draft_id, kind: row.kind, title: row.title, revision: row.revision,
          created_at: row.created_at, updated_at: row.updated_at, from: describeOrigin(row.origin),
          ready: validation.valid, problems: validation.issues.filter((issue) => issue.severity === 'error').length,
          ...baseOf(row) };
      });
    },
    create: db.transaction((kind: KitchenImportDraft['kind'], source: string, base?: KitchenWorkBase): KitchenImportDraft => {
      if (base !== undefined && kind !== 'recipe') return bad('Only a recipe keeps changes to a saved one.');
      // One item per saved recipe, of any origin: Recued's changes to it count too (D-402 slice E4c).
      if (base !== undefined && db.prepare('SELECT 1 FROM kitchen_import_draft WHERE base_recipe_id = ?')
        .get(base.recipe_id)) {
        throw new RpcError('conflict', 'Changes to this recipe are already in progress. Reopen it to continue them.', 409);
      }
      // The import path, under the owner's origin: the same size, validation and limit rules.
      const created = importDraft(KITCHEN_OWNER_ORIGIN, { kind, source, request_id: randomUUID(),
        title: sourceName(kind, source) ?? (kind === 'recipe' ? 'New recipe' : 'New pack') });
      if (base !== undefined) {
        db.prepare('UPDATE kitchen_import_draft SET base_recipe_id = ?, base_version = ? WHERE draft_id = ?')
          .run(base.recipe_id, base.version, created.draft_id);
      }
      return getDraft(created.draft_id)!;
    }).immediate,
    createCompiled: db.transaction((input: { origin: string; kind: KitchenImportDraft['kind']; source: string;
      title?: string; notes: readonly string[]; made_from: KitchenDraftMadeFrom; base?: KitchenWorkBase }): KitchenImportDraft => {
      if (!input.origin.startsWith(KITCHEN_COMPILED_ORIGIN_PREFIX)) return bad('Only Recued compiles a draft under its own origin.');
      if (input.base !== undefined && input.kind !== 'recipe') return bad('Only a recipe keeps changes to a saved one.');
      if (input.base !== undefined && db.prepare('SELECT 1 FROM kitchen_import_draft WHERE base_recipe_id = ?')
        .get(input.base.recipe_id)) {
        throw new RpcError('conflict', 'Changes to this recipe are already in progress. Reopen it to continue them.', 409);
      }
      if (input.notes.length > KITCHEN_DRAFT_MAX_NOTES
        || input.notes.some((note) => typeof note !== 'string' || note.length > KITCHEN_DRAFT_NOTE_MAX_CHARS)) {
        return bad(`A compiled draft keeps at most ${KITCHEN_DRAFT_MAX_NOTES} notes of ${KITCHEN_DRAFT_NOTE_MAX_CHARS} characters.`);
      }
      const created = importDraft(input.origin, { kind: input.kind, source: input.source, request_id: randomUUID(),
        title: input.title ?? sourceName(input.kind, input.source) ?? (input.kind === 'recipe' ? 'New recipe' : 'New pack') });
      db.prepare('UPDATE kitchen_import_draft SET notes_json = ?, made_from_json = ? WHERE draft_id = ?')
        .run(JSON.stringify(input.notes), JSON.stringify(input.made_from), created.draft_id);
      if (input.base !== undefined) {
        db.prepare('UPDATE kitchen_import_draft SET base_recipe_id = ?, base_version = ? WHERE draft_id = ?')
          .run(input.base.recipe_id, input.base.version, created.draft_id);
      }
      return getDraft(created.draft_id)!;
    }).immediate,
  };
};
