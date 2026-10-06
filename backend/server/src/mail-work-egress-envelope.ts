import { MAIL_WORK_EVIDENCE_NOTE, MAIL_WORK_EVIDENCE_READ_TOOLS, MAIL_WORK_EVIDENCE_TOOL,
  MAIL_WORK_SOURCE_CATALOG_NOTE, MAIL_WORK_SOURCE_CATALOG_TOOL } from './mail-work-evidence.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const FIELDS = ['note', 'version', 'investigation_request', 'owner_notes_recorded_at_iso', 'owner_updates', 'owner_updates_before_request', 'observed_at', 'observations', 'source_catalog', 'passage_catalog'];
const CALL_FIELDS = ['tool_name', 'tier', 'status', 'started_at', 'completed_at', 'args', 'result', 'detail', 'reason', 'recap_source'];
const DATA = ['args', 'result', 'detail', 'reason'];
const PASSAGE_KEYS = ['id', 'source', 'text'];
const isPassages = (value: unknown): value is Array<Record<string, string>> => Array.isArray(value)
  && value.every(row => object(row) && Object.keys(row).length === 3
    && PASSAGE_KEYS.every(key => typeof row[key] === 'string') && /^passage_[0-9a-f]{16}$/u.test(String(row.id))
    && String(row.text).length > 0 && String(row.text).length <= 900);
const packPassages = (rows: Array<Record<string, string>>) => rows.map(row => PASSAGE_KEYS.map(key => row[key]));
const restorePassages = (data: unknown, count: number) => {
  if (!Array.isArray(data) || data.length !== count || !data.every(row => Array.isArray(row) && row.length === 3
    && row.every(value => typeof value === 'string'))) throw new Error('Mail work passages lost data');
  return data.map(row => Object.fromEntries(PASSAGE_KEYS.map((key, i) => [key, row[i]])));
};
const catalogKeys = (row: Record<string, unknown>): string[] => Object.hasOwn(row, 'source_text')
  ? ['source', 'source_text'] : typeof row.file_ref === 'string'
    ? ['source', 'source_url', 'file_ref', 'content_hash', 'read_version']
    : Object.hasOwn(row, 'scope_role') ? ['source', 'source_url', 'scope_role'] : ['source', 'source_url'];
const isCatalog = (value: unknown): value is Array<Record<string, string>> => Array.isArray(value) && value.length <= 110
  && value.every(row => object(row) && Object.keys(row).length === catalogKeys(row).length
    && catalogKeys(row).every(key => typeof row[key] === 'string')
    && (!Object.hasOwn(row, 'scope_role') || (/^mail_[0-9a-f]{12}$/u.test(String(row.source))
      && (row.scope_role === 'work_anchor' || row.scope_role === 'context_candidate')))
    && (Object.hasOwn(row, 'source_text') ? /^owner_(?:request|update_[1-9][0-9]*)$/u : /^(?:mail|document)_[0-9a-f]{12}$/u).test(String(row.source)));
const restoreCatalog = (data: unknown, original: Array<Record<string, string>>): Array<Record<string, string>> => {
  if (!Array.isArray(data) || data.length !== original.length
    || !data.every((row, index) => Array.isArray(row) && row.length === catalogKeys(original[index]!).length && row.every(v => typeof v === 'string'))) {
    throw new Error('Mail work source catalog lost data');
  }
  return data.map((row, index) => Object.fromEntries(catalogKeys(original[index]!).map((key, i) => [key, row[i]])));
};

/** Only a top-level host evidence call gets this projection. Nested lookalikes
 * and arbitrary data keys still traverse every normal privacy pass. Remove
 * protocol keys from the scan, not their values, then reattach the fixed keys.
 * The note must be our exact constant; it contains no source/owner content.
 * Arrays keep this valid through the key-aware candidate and warehouse scans. */
export const packMailWorkEnvelopes = (packet: Record<string, unknown>): ((aliased: Record<string, unknown>) => void) | null => {
  const restore: Array<(aliased: Record<string, unknown>) => void> = [];
  for (const lane of ['prior_tool_calls', 'tool_results_since'] as const) {
    const calls = packet[lane];
    if (!Array.isArray(calls)) continue;
    const restoreLane = (apply: (calls: unknown[]) => void): void => {
      restore.push(aliased => {
        if (!Array.isArray(aliased[lane])) throw new Error('Mail work envelope lost calls');
        apply(aliased[lane]);
      });
    };
    calls.forEach((call: unknown, index) => {
      if (object(call) && call.tool_name === 'mail.work.passage_catalog' && call.status === 'ok'
        && object(call.result) && Object.keys(call.result).length === 2 && call.result.note === MAIL_WORK_SOURCE_CATALOG_NOTE
        && isPassages(call.result.passage_catalog)) {
        const count = call.result.passage_catalog.length;
        call.result = packPassages(call.result.passage_catalog);
        restoreLane(calls => {
          const target = calls[index];
          if (!object(target) || target.tool_name !== 'mail.work.passage_catalog') throw new Error('Mail work passages lost');
          if (typeof target.result === 'string') return;
          target.result = { note: MAIL_WORK_SOURCE_CATALOG_NOTE, passage_catalog: restorePassages(target.result, count) };
        });
        return;
      }
      if (object(call) && call.tool_name === MAIL_WORK_SOURCE_CATALOG_TOOL && call.status === 'ok' && call.tier === 1
        && object(call.result) && Object.keys(call.result).length === (Object.hasOwn(call.result, 'passage_catalog') ? 3 : 2)
        && (!Object.hasOwn(call.result, 'passage_catalog') || isPassages(call.result.passage_catalog)) && call.result.note === MAIL_WORK_SOURCE_CATALOG_NOTE
        && isCatalog(call.result.source_catalog)) {
        const catalog = call.result.source_catalog;
        const passages = call.result.passage_catalog as Array<Record<string, string>> | undefined;
        const values = catalog.map(row => catalogKeys(row).map(key => row[key]));
        call.result = passages ? [values, packPassages(passages)] : values;
        restoreLane(calls => {
          const target = calls[index];
          if (!object(target) || target.tool_name !== MAIL_WORK_SOURCE_CATALOG_TOOL) throw new Error('Mail work catalog lost');
          if (typeof target.result === 'string') return;
          const data = target.result;
          if (passages && (!Array.isArray(data) || data.length !== 2)) throw new Error('Mail work catalog lost data');
          target.result = { note: MAIL_WORK_SOURCE_CATALOG_NOTE, source_catalog: restoreCatalog(passages ? (data as unknown[])[0] : data, catalog),
            ...(passages ? { passage_catalog: restorePassages((data as unknown[])[1], passages.length) } : {}) };
        });
        return;
      }
      const ownerKeys = ['title', 'desired_outcome', 'owner_notes', 'resolution_note'];
      if (object(call) && object(call.result) && Object.hasOwn(call.result, 'owner_notes_recorded_at_iso')) {
        ownerKeys.push('owner_notes_recorded_at_iso');
      }
      if (object(call) && call.tool_name === 'mail.work.owner_context' && call.status === 'ok'
        && object(call.result) && Object.keys(call.result).length === ownerKeys.length
        && ownerKeys.every(k => typeof (call.result as Record<string, unknown>)[k] === 'string'
          || (k === 'owner_notes_recorded_at_iso' && (call.result as Record<string, unknown>)[k] === null))) {
        const values = call.result;
        call.result = ownerKeys.map(k => values[k]);
        restoreLane(calls => {
          const target = calls[index];
          if (!object(target)) throw new Error('Mail owner context lost');
          if (typeof target.result === 'string') return; // withheld
          const data = target.result;
          if (!Array.isArray(data) || data.length !== ownerKeys.length) throw new Error('Mail owner context lost data');
          target.result = Object.fromEntries(ownerKeys.map((k, i) => [k, data[i]]));
        });
        return;
      }
      if (!object(call) || call.tool_name !== MAIL_WORK_EVIDENCE_TOOL || call.status !== 'ok' || call.tier !== 1) return;
      const r = call.result;
      if (!object(r) || Object.keys(r).some(k => !FIELDS.includes(k)) || r.note !== MAIL_WORK_EVIDENCE_NOTE
        || r.version !== 1 || typeof r.investigation_request !== 'string' || !Array.isArray(r.owner_updates)
        || !r.owner_updates.every(x => typeof x === 'string') || !Number.isInteger(r.owner_updates_before_request)
        || typeof r.observed_at !== 'number' || !Array.isArray(r.observations)) return;
      const observations = r.observations;
      if (!observations.every((c: unknown) => object(c) && MAIL_WORK_EVIDENCE_READ_TOOLS.has(String(c.tool_name))
        && c.tier === 1 && (c.status === 'ok' || c.status === 'error') && typeof c.started_at === 'number'
        && typeof c.completed_at === 'number' && Object.keys(c).every(k => CALL_FIELDS.includes(k)))) return;
      const hasCatalog = Object.hasOwn(r, 'source_catalog');
      const catalog = r.source_catalog;
      const hasPassages = Object.hasOwn(r, 'passage_catalog');
      const passages = r.passage_catalog;
      if (hasPassages && !isPassages(passages)) return;
      const hasNoteTime = Object.hasOwn(r, 'owner_notes_recorded_at_iso');
      if (hasNoteTime && r.owner_notes_recorded_at_iso !== null && typeof r.owner_notes_recorded_at_iso !== 'string') return;
      if (hasCatalog && !isCatalog(catalog)) return;
      if (observations.some(c => Object.hasOwn(c, 'recap_source') && (c.tool_name !== 'mail.read' || c.status !== 'ok'
        || !object(c.result) || typeof c.result.body !== 'string' || !Array.isArray(catalog)
        || !catalog.some(row => row.source === c.recap_source && row.source_url === c.result.source_url)))) return;
      // Annotation values traverse privacy with the bodies and catalog. The
      // earlier four-value observation envelope remains exact when absent.
      const dataKeys = observations.some(c => Object.hasOwn(c, 'recap_source')) ? [...DATA, 'recap_source'] : DATA;
      // Preserve only fixed protocol keys. Both handle and URL values traverse
      // the same privacy passes as source bodies; nothing is restored raw.
      call.result = [r.investigation_request, r.owner_updates, observations.map(c => dataKeys.map(k => c[k] ?? null)),
        ...(hasCatalog ? [(catalog as Array<Record<string, unknown>>).map(row => catalogKeys(row).map(key => row[key]))] : []),
        ...(hasPassages ? [packPassages(passages as Array<Record<string, string>>)] : []),
        ...(hasNoteTime ? [r.owner_notes_recorded_at_iso] : [])];
      restoreLane(calls => {
        const target = calls[index];
        if (!object(target) || target.tool_name !== MAIL_WORK_EVIDENCE_TOOL) throw new Error('Mail work envelope lost');
        const data = target.result;
        // A failed warehouse scan withholds the complete data value. Do not
        // restore any raw contents around it or turn it into apparent evidence.
        if (typeof data === 'string') return;
        if (!Array.isArray(data) || data.length !== 3 + Number(hasCatalog) + Number(hasPassages) + Number(hasNoteTime) || !Array.isArray(data[2]) || data[2].length !== observations.length) {
          throw new Error('Mail work envelope lost data');
        }
        const restored: Record<string, unknown> = { ...r, investigation_request: data[0], owner_updates: data[1], observations: observations.map((c, i) => {
          const values = data[2][i];
          if (!Array.isArray(values) || values.length !== dataKeys.length) throw new Error('Mail work observation lost data');
          const next = { ...c };
          dataKeys.forEach((k, j) => { if (Object.hasOwn(c, k)) next[k] = values[j]; });
          return next;
        }) };
        if (hasCatalog) {
          restored.source_catalog = restoreCatalog(data[3], catalog as Array<Record<string, string>>);
        }
        if (hasPassages) restored.passage_catalog = restorePassages(data[3 + Number(hasCatalog)], (passages as unknown[]).length);
        if (hasNoteTime) restored.owner_notes_recorded_at_iso = data[3 + Number(hasCatalog) + Number(hasPassages)];
        target.result = restored;
      });
    });
  }
  return restore.length ? aliased => {
    for (const apply of restore) apply(aliased);
  } : null;
};
