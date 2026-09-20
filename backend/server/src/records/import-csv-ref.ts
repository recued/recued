/** The `csv_ref` → `csv` dereference for a records `import`, and the ONE place
 *  the ref backing is adjudicated.
 *
 *  ⛔⛔ WHY THIS SITS OUTSIDE THE STORE, not inside `importCsv`. Two reasons,
 *  either of which alone would decide it:
 *
 *   1. `RecordsStore.execute` is SYNCHRONOUS end to end — `db.transaction(...)`
 *      with no `await` anywhere beneath it. Dereferencing inside the store would
 *      mean making the whole records execute path async for one action.
 *   2. The store would have to gain a file-reading dependency. Records is the
 *      substrate for a pack's own rows; handing it a reader is a new capability
 *      edge on the one component that should have none.
 *
 *  ⇒ The rewrite happens in the server wiring (`execute-handler.ts`, the
 *  `recordsOperationExecutor` closure), AFTER the D-165 catalog gateway has
 *  admitted the op — grant, approval, reachability and principal all resolved —
 *  and BEFORE `execute`. The store keeps receiving `{ csv: string }` and stays
 *  both synchronous and file-ignorant.
 *
 *  ⛔⛔ AND WHY ONLY A `temp` BACKING IS ADMITTED. The full ruling lives on the
 *  `import` entry in `packages/contracts/src/records.ts`; the short form is that
 *  the gated boundary is EGRESS, not dereference. A cli op may already
 *  dereference a durable `file_ref` at `approval: 'never'` (`xlsx2csv`'s
 *  `spreadsheet.to_csv`) because its sink is confined — stdout/stderr
 *  suppressed, output another opaque ref, so no content reaches the actor.
 *  `import`'s sink is NOT confined: imported rows read straight back out through
 *  the pack's own `search` / `get`. So a durable CAS ref here would be a new
 *  ungated egress path for arbitrary file content, and a `{slug, path}` pair
 *  would be ambient authority over any enrolled instance.
 *
 *  A run-scoped `TempFileRef` has neither problem. D-185 §3.2: it "carries no
 *  separate Gateway `file.read` gate (the producing op was already gated as its
 *  own write-tier step)", and `assertPathUnderRunScratch` confines it to THIS
 *  run's scratch root — so the only nameable files are outputs of ops this run
 *  already dispatched under their own grants. The confinement is on the INPUT
 *  side, which is what makes the unconfined sink survivable.
 */

import { createHash } from 'node:crypto';

import {
  isTempFileRef,
  RECORDS_IMPORT_MAX_CSV_BYTES,
  RecordsContractError,
  type RecordsExecutionCall,
  type RecordsImportResult,
} from '@recued/contracts';

import { readConfinedTempBytes } from '../execution/run-scratch.js';

/** What a dereference produced, for the caller to fold onto the store's result.
 *  `source_sha256` is the one fact the audit row cannot carry on this path (the
 *  gateway hashes the ref's run-scoped `path`, which names nothing once the run
 *  ends), so it is handed back rather than discarded. */
export interface ResolvedImportCsvRef {
  call: RecordsExecutionCall;
  source_sha256?: string;
}

/** ⚠ RETURNS the error; every call site `throw`s it. An arrow const typed
 *  `: never` does NOT narrow control flow for TypeScript, so a helper that threw
 *  internally left `ref` un-narrowed after the guard — which compiles only by
 *  casting, and a cast here is exactly the thing the guard exists to avoid. */
const invalid = (message: string): RecordsContractError =>
  new RecordsContractError('records_invalid', message);

/** ⛔ A CAS RECORD ID IS THE ONE WRONG VALUE THAT LOOKS RIGHT, so it gets its own
 *  message. `isTempFileRef` rejects a bare string, and a generic "not a temp
 *  ref" would leave an author who passed `{{config.file}}` — the exact value
 *  every shipped import recipe already holds — with no idea why. Name the route
 *  that does work. */
const refusedBacking = (value: unknown): RecordsContractError => {
  if (typeof value === 'string') {
    return invalid(
      "import csv_ref takes a run-scoped temp file_ref, not a data.file record id — "
      + 'a durable file is read with `core.storage.data-file-read` → `decode_base64` → '
      + '`csv`, which is what gates its content becoming readable',
    );
  }
  if (value !== null && typeof value === 'object'
    && ('slug' in value || 'path' in value) && !('backing' in value)) {
    return invalid(
      "import csv_ref takes a run-scoped temp file_ref, not a {slug, path} instance address — "
      + 'a named file instance is read with `core.storage.data-file-read` → `decode_base64` → `csv`',
    );
  }
  return invalid(
    'import csv_ref must be a run-scoped temp file_ref '
    + "({ backing: 'temp', path, mime_type, filename }) — the output of a same-run "
    + "cli op declaring shape: 'ref'",
  );
};

/** Rewrite an `import` call carrying `csv_ref` into one carrying `csv` text.
 *  Every other call — every other action, and an `import` passing `csv` text —
 *  is returned untouched, so this is safe to put on the executor unconditionally.
 *
 *  ⚠ THE EXACTLY-ONE-OF CHECK REFUSES RATHER THAN PREFERRING. A caller that
 *  passed both meant one of them, and resolving by precedence silently imports
 *  the wrong file — the same rule `CsvAddress` already states for the csv ops
 *  ("Ambiguity is refused rather than resolved by precedence"). */
export const resolveRecordsImportCsvRef = (
  call: RecordsExecutionCall,
  run_id: string,
): ResolvedImportCsvRef => {
  if (call.binding.action !== 'import') return { call };
  const ref = call.args.csv_ref;
  const hasRef = ref !== undefined && ref !== null;
  const hasText = call.args.csv !== undefined && call.args.csv !== null;
  if (!hasRef) return { call };
  if (hasText) {
    throw invalid('import takes csv OR csv_ref, not both');
  }
  if (!isTempFileRef(ref)) throw refusedBacking(ref);

  let bytes: Buffer;
  try {
    ({ bytes } = readConfinedTempBytes(ref, run_id));
  } catch (error) {
    // ⛔ The confinement helper throws plain `Error`s — a ref that outlived its
    // run, a path that escaped the scratch root, an unreadable file. Every one
    // is a fact about the CALL, so they carry the caller-facing code rather than
    // surfacing as an opaque dispatch failure in a different vocabulary from the
    // rest of the action's refusals.
    throw invalid(
      `import csv_ref could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // ⛔⛔ THE CEILING, AND IT IS CHECKED HERE BECAUSE NOTHING ELSE CHECKS IT. `csv`
  // text is bounded on the way in by the engine's `MAX_CONTEXT_BYTES` because it
  // transits step state; these bytes never do, so this is the last point before a
  // file is decoded into memory — the same position, and the same 32 MiB, that
  // `csv-filter` refuses at.
  if (bytes.length > RECORDS_IMPORT_MAX_CSV_BYTES) {
    throw invalid(
      `import csv_ref '${ref.filename}' is ${bytes.length} bytes, past the `
      + `${RECORDS_IMPORT_MAX_CSV_BYTES}-byte ceiling`,
    );
  }
  const source_sha256 = createHash('sha256').update(bytes).digest('hex');
  // `csv_ref` is DROPPED rather than carried alongside: the store fails closed on
  // a surviving `csv_ref` (that would mean this rewrite never ran), and leaving
  // it would make that guard unreachable on the one path it exists for.
  const { csv_ref: _dropped, ...rest } = call.args;
  return {
    call: { ...call, args: { ...rest, csv: bytes.toString('utf8') } },
    source_sha256,
  };
};

/** The composed records executor: dereference, then execute, then fold
 *  `source_sha256` onto the result.
 *
 *  🔑 IT IS A FACTORY SO THE JOIN ITSELF IS TESTABLE. Resolving and executing
 *  are each easy to test alone, and both pass while the two are never composed —
 *  the host would simply pass every `csv_ref` straight to a store that refuses it.
 *  Keeping the composition here means the test drives the REAL one instead of
 *  hand-wiring a copy that can agree with nothing.
 *
 *  ⚠ The `execute` parameter is the store's own `execute`, narrowed to what this
 *  needs. It stays a parameter rather than a `RecordsStore` so the factory cannot
 *  reach anything else on the store. */
export const composeRecordsOperationExecutor = (
  execute: (call: RecordsExecutionCall) => unknown,
  run_id: string,
) => (call: RecordsExecutionCall): unknown => {
  const resolved = resolveRecordsImportCsvRef(call, run_id);
  const result = execute(resolved.call);
  return resolved.source_sha256 === undefined
    ? result
    : { ...(result as RecordsImportResult), source_sha256: resolved.source_sha256 };
};
