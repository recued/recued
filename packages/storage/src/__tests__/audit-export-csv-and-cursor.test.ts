/** D-120 P7 — the CSV serializer and the page cursor.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18): 20 mutations of `audit-export.ts`, NINETEEN
 *  survived. The cursor codec and the whole CSV body were effectively untested —
 *  every escaping rule, every cursor validation, and the header/row alignment
 *  could be deleted with the suite green. The existing tests drive `exportPage`
 *  in JSON, where `JSON.stringify` does the escaping and the cursor is absent.
 *
 *  ⛔ CSV ESCAPING IS NOT COSMETIC. A comma, a quote or a newline in any cell
 *  does not render badly — it SHIFTS EVERY COLUMN AFTER IT, silently, in a file
 *  whose whole purpose is to be read by something that trusts the column order.
 *  `trigger_url`, `output_string` and error codes all carry text this module
 *  does not control. */

import { describe, expect, it } from 'vitest';

import { decodeAuditExportCursor, exportPage } from '../audit-export.js';
import type { AuditExportSource, AuditExportIdentity } from '../audit-export.js';
import type { AuditEntry } from '../audit.js';
import type { RecipeError } from '@recued/contracts';

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  recipe_hash: 'hash-1',
  started_at: 1_700_000_000_000,
  finished_at: 1_700_000_001_000,
  duration_ms: 1_000,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
  ...over,
} as AuditEntry);

/** A fully-shaped `RecipeError` — the CSV only reads `.code`, but the fixture
 *  must typecheck or it is asserting against a lie. */
const recipeError = (code: string): RecipeError => ({
  error_id: `err-${code}`,
  code,
  message: code,
  severity: 'error',
  source: { recipe_id: 'recipe-1', step_id: null, ingredient_slug: null },
  details: {},
  timestamp: '2026-09-18T00:00:00.000Z',
  retryable: false,
} as RecipeError);

const sourceOf = (entries: AuditEntry[]): AuditExportSource => ({
  fetchEntries: async () => entries,
  fetchLinks: async () => [],
  fetchInsights: async () => [],
  count: async () => entries.length,
} as unknown as AuditExportSource);

const identity: AuditExportIdentity = {
  instance_id: 'inst-1',
  scope: 'local',
  now: () => 1_700_000_002_000,
};

const bodyOf = async (entries: AuditEntry[]): Promise<string> => {
  const page = await exportPage(sourceOf(entries), identity, { format: 'csv' });
  return page.body;
};

/** ⚠ Only safe for fixtures with NO embedded newline — see the newline test. */
const csvOf = async (entries: AuditEntry[]): Promise<string[]> =>
  (await bodyOf(entries)).split('\n');

describe('D-120 P7 — the CSV body survives the characters CSV cares about', () => {
  it('⛔⛔ a value containing a COMMA is quoted, so columns do not shift', async () => {
    const [, row] = await csvOf([entry({ recipe_id: 'a,b' })]);
    expect(row).toContain('"a,b"');
  });

  it('⛔⛔ an embedded QUOTE is doubled, so the field does not terminate early', async () => {
    const [, row] = await csvOf([entry({ recipe_id: 'say "hi"' })]);
    expect(row).toContain('"say ""hi"""');
  });

  it('⛔⛔ a NEWLINE is QUOTED, so a parser reads one record not two', async () => {
    // ⚠ MY FIRST VERSION COUNTED `body.split('\n')` AND WAS WRONG. A correctly
    // quoted newline is still a newline in the bytes — that is the point of the
    // quotes — so a line count is 2 either way and proves nothing. The QUOTED
    // FORM is what distinguishes them: unquoted, the field appears bare.
    const body = await bodyOf([entry({ recipe_id: 'line1\nline2' })]);
    expect(body, 'the newline was emitted unquoted — the record splits').toContain(
      '"line1\nline2"',
    );
  });

  it('⛔ a CARRIAGE RETURN is quoted too', async () => {
    const body = await bodyOf([entry({ recipe_id: 'line1\r\nline2' })]);
    expect(body).toContain('"line1\r\nline2"');
  });

  it('⛔ null and undefined render as EMPTY cells, never as "null"', async () => {
    const [, row] = await csvOf([entry({ trigger_url: null, instance_id: null })]);
    expect(row).not.toContain('null');
    expect(row).not.toContain('undefined');
  });

  it('⛔⛔ the header and every row have the SAME number of columns', async () => {
    // ⛔ `CSV_HEADERS` and `csvRow` are two parallel lists that must stay in
    // step, and the file's own comments show three fields appended over time
    // (D-153 P1.B, D-232 § 20.14, D-232 § 30) — each needing both edits. Drop
    // one from the row and every column after it shifts by one, in a file
    // nothing validates. Counted on values chosen to contain NO commas, so a
    // naive split is a correct parse here.
    const lines = await csvOf([entry(), entry({ run_id: 'run-2' })]);
    const header = lines[0]!.split(',');
    expect(header.length).toBeGreaterThan(15);
    for (const [i, line] of lines.slice(1).entries()) {
      expect(
        line.split(',').length,
        `row ${i} has ${line.split(',').length} columns, header has ${header.length}`,
      ).toBe(header.length);
    }
  });

  it('⚠ the lossy collapses are the documented ones', async () => {
    // CSV is "for eyeballing" per the module, but the separators are a contract
    // with whoever eyeballs it: `;` between errors, and `kind:entity@ts` links.
    const [, row] = await csvOf([
      entry({
        errors: [recipeError('step_failed'), recipeError('timeout')],
      }),
    ]);
    expect(row).toContain('step_failed;timeout');
  });
});

describe('D-120 P7 — the page cursor', () => {
  it('⛔ a malformed token is ignored, never thrown', async () => {
    // The caller treats null as "start from the head", so a corrupt token from
    // a stale URL restarts the export rather than failing it.
    for (const raw of ['', 'not-base64!!', 'YWJj', btoa('{"nope":1}')]) {
      expect(() => decodeAuditExportCursor(raw), raw).not.toThrow();
      expect(decodeAuditExportCursor(raw), raw).toBeNull();
    }
    expect(decodeAuditExportCursor(undefined)).toBeNull();
  });

  it('⛔ every field is validated on its own', async () => {
    // ⚠ ONE FIELD WRONG AT A TIME from an otherwise-valid cursor, so each check
    // is the only thing that can decide.
    const b64url = (o: unknown): string =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const valid = { last_started_at: 1_700_000_000_000, last_run_id: 'run-1' };
    expect(decodeAuditExportCursor(b64url(valid))).toEqual(valid);
    for (const [label, bad] of [
      ['started_at is a string', { ...valid, last_started_at: '1' }],
      ['started_at is absent', { last_run_id: 'run-1' }],
      ['started_at is NaN-ish', { ...valid, last_started_at: null }],
      ['run_id is absent', { last_started_at: 1 }],
      ['run_id is a number', { ...valid, last_run_id: 7 }],
      ['payload is an array', [1, 2]],
      ['payload is a string', 'nope'],
    ] as const) {
      expect(decodeAuditExportCursor(b64url(bad)), label).toBeNull();
    }
  });

  it('⛔⛔ the emitted cursor is URL-SAFE and round-trips', async () => {
    // ⚠ It is stashed in a query string when the dialog pages, so a `+` or `/`
    // from plain base64 would be mangled in transit and decode to null —
    // silently restarting the export from the head, forever, on exactly the
    // rows whose cursor happens to encode one.
    const page = await exportPage(
      sourceOf([entry({ run_id: 'run-a' }), entry({ run_id: 'run-b' })]),
      identity,
      { format: 'csv', page_size: 2 },
    );
    const token = page.next_cursor;
    if (token === undefined || token === null) return; // no further page
    expect(token, 'the cursor is not URL-safe').not.toMatch(/[+/=]/);
    const decoded = decodeAuditExportCursor(token);
    expect(decoded).not.toBeNull();
    expect(
      decoded?.last_run_id,
      'the cursor lost its run_id tiebreak — same-ms runs paginate nondeterministically',
    ).toBe('run-b');
  });
});

describe('D-120 P7 — the rest of the body, and the envelope window', () => {
  it('⛔⛔ an OMITTED since/until renders as null, not as 1970', async () => {
    // ⛔ THE COMMON CASE. Both are optional on the request, so `toIso(undefined)`
    // runs on every unbounded export — and without its guard it renders
    // `1970-01-01T00:00:00.000Z`, which reads as a real window start. An
    // envelope that claims a bound it never had is worse than one that says
    // "no bound": a reader diffing two exports would see a window that moved.
    const page = await exportPage(sourceOf([entry()]), identity, { format: 'json' });
    expect(page.envelope?.since, 'an absent `since` rendered as a date').toBeNull();
    expect(page.envelope?.until, 'an absent `until` rendered as a date').toBeNull();
  });

  it('⚠ and a supplied window is rendered as ISO', async () => {
    const page = await exportPage(sourceOf([entry()]), identity, {
      format: 'json',
      since: 1_700_000_000_000,
      until: 1_700_000_005_000,
    });
    expect(page.envelope?.since).toBe('2023-11-14T22:13:20.000Z');
    expect(page.envelope?.until).toBe('2023-11-14T22:13:25.000Z');
  });

  it('⛔⛔ a cursor whose base64 contains + or / still decodes', async () => {
    // ⚠ FIXTURE CHOSEN SO THE SUBSTITUTION MATTERS. Most run ids encode to
    // base64 with no `+` or `/` at all, so a decoder that skipped the URL-safe
    // reversal passed every test — the mutation survived until this case.
    // `run-a>b` produces a `+`; `run~??` produces a `/`.
    const b64url = (o: unknown): string =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const last_run_id of ['run-a>b', 'run~??']) {
      const cursor = { last_started_at: 1_700_000_000_000, last_run_id };
      const token = b64url(cursor);
      expect(token, `${last_run_id}: fixture no longer needs the substitution`)
        .toMatch(/[-_]/);
      expect(decodeAuditExportCursor(token), last_run_id).toEqual(cursor);
    }
  });

  it('⛔ the links column keeps its timestamp', async () => {
    // `kind:entity@ts` is the documented collapse; dropping the `@ts` makes two
    // links to the same entity indistinguishable in the spreadsheet.
    const src: AuditExportSource = {
      ...sourceOf([entry({ run_id: 'run-1' })]),
      fetchLinks: async () => [
        { memory_id: 'run-1', entity_id: 'ent-1', kind: 'derived_from', ts: 1_736_000_000_000 },
      ],
    } as unknown as AuditExportSource;
    const page = await exportPage(src, identity, { format: 'csv' });
    expect(page.body).toContain('derived_from:ent-1@1736000000000');
  });

  it('⛔⛔ a REFUSED peer verdict does not render as accepted', async () => {
    // ⛔ THE ONE CELL WHERE A WRONG VALUE INVERTS A FACT. The verdict is
    // flattened to `<accepted|refused>:<kind>`; rendering every ack as
    // "accepted" turns a peer's refusal into its consent in the only view a
    // human is likely to read.
    const page = await exportPage(
      sourceOf([
        entry({
          run_id: 'run-refused',
          exchange_peer_ack: { ref: 'ex-1', accepted: false, kind: 'policy' },
        }),
      ]),
      identity,
      { format: 'csv' },
    );
    expect(page.body).toContain('refused:policy');
    expect(page.body).not.toContain('accepted:policy');
  });
});

describe('D-120 P7 — formula-looking cells are NEUTRALISED', () => {
  /** ⚠⚠ THIS BLOCK WAS A CHARACTERISATION TEST AND HAS NOW FLIPPED, WHICH IS
   *  WHAT IT WAS FOR. It first recorded that a cell beginning `=`, `+`, `-` or
   *  `@` was emitted BARE; adopting the shared `csvCell` changed that, and the
   *  three assertions below failed until they were deliberately rewritten. A
   *  silent change in export bytes is exactly what it existed to prevent.
   *
   *  ⛔ THE KEY FACT, AND THE ONE THAT MISLEADS: CSV QUOTING DOES NOT NEUTRALISE
   *  A FORMULA. They are different layers. Quoting is for the PARSER — it makes
   *  field boundaries unambiguous. Evaluation happens AFTER parsing, in the
   *  APPLICATION: Excel strips the quotes, gets `=HYPERLINK(...)`, sees the
   *  leading `=` and evaluates it. So adding `=` to `csvEscape`'s regex would
   *  achieve nothing — the fix, if we want one, is a `'` PREFIX on the value,
   *  which is a different operation applied to different columns.
   *
   *  ⇒ RESOLVED: the rule now lives in `packages/contracts/src/csv.ts` and is
   *  applied by all four CSV writers. It was lifted verbatim from
   *  `form-response-handler.ts`, which had it first and for the best reason —
   *  its cells carry text other people submitted through a form.
   *
   *  ⚠ The realistic source is not the owner typing `=`. It is `output_string`
   *  (AI text, steerable by ingested mail or a peer exchange), `trigger_url`,
   *  and the D-232 peer fields — content this module does not control. */

  it('⛔⛔ a formula-looking value is PREFIXED, so the spreadsheet reads it as text', async () => {
    const body = await bodyOf([entry({ recipe_id: '=1+1' })]);
    expect(body).toContain(",'=1+1,");
    expect(body, 'the bare formula reached the file').not.toContain(',=1+1,');
  });

  it('⛔ every spreadsheet trigger character is neutralised', async () => {
    for (const value of ['=cmd', '+1', '-1', '@SUM(A1)']) {
      const body = await bodyOf([entry({ recipe_id: value })]);
      expect(body, `${value} was left live`).toContain(`,'${value},`);
    }
    // ⚠ Past leading whitespace too — ` =1` still evaluates in some apps.
    const spaced = await bodyOf([entry({ recipe_id: '  =1+1' })]);
    expect(spaced).toContain(",'  =1+1,");
  });

  it('⛔ an ordinary value is NOT prefixed — neutralisation is not a blanket', async () => {
    // The complement. A rule that prefixed everything would be invisible to the
    // test above and would corrupt every cell in the file.
    const body = await bodyOf([entry({ recipe_id: 'ordinary' })]);
    expect(body).toContain(',ordinary,');
    expect(body).not.toContain(",'ordinary");
  });

  it('⛔ a formula that also needs QUOTING gets both, in the right order', async () => {
    // ⚠ ORDER IS LOAD-BEARING: the prefix changes the value, so the quoting
    // decision must be made on the FINAL text. Reversed, the escape would be
    // computed on the pre-prefix string.
    const body = await bodyOf([entry({ recipe_id: '=HYPERLINK("http://x","go"),y' })]);
    expect(body).toContain('"\'=HYPERLINK(""http://x"",""go""),y"');
  });

  it('⚠ the NUMERIC columns render bare — a neutralising fix must not change this', async () => {
    // Pinned ahead of the decision, because it is the constraint that shapes
    // it: a blanket `'` prefix would turn these into text, and `-` collides
    // with a real negative number. Any fix has to be per-column.
    const body = await bodyOf([
      entry({ started_at: 1_700_000_000_000, finished_at: 1_700_000_001_000, duration_ms: 1_000 }),
    ]);
    expect(body).toContain(',1700000000000,1700000001000,1000,');
  });
});

/* ─── Mutation sweep of `packages/storage/src/audit-export.ts`, 2026-09-18 ──
 *  20 mutations; NINETEEN survived on the first pass — the worst ratio of this
 *  whole review. The existing suites drive `exportPage` in JSON, where
 *  `JSON.stringify` does the escaping and no cursor is issued, so the CSV body
 *  and the cursor codec were untested end to end.
 *
 *  14 are now caught. The six that remain are EQUIVALENT OR UNREACHABLE, each
 *  measured rather than argued:
 *
 *  1. `toIso`'s `epoch === undefined` guard. `Number.isFinite(undefined)` is
 *     FALSE, so the very next line already returns null. Two rules, one answer.
 *  2. `toIso`'s `Number.isFinite` guard, for a non-finite NUMBER. `since` /
 *     `until` arrive as JSON, and `JSON.parse('NaN')` is a SyntaxError — the
 *     wire cannot carry one.
 *  3. Same for the cursor's `Number.isFinite(last_started_at)`.
 *  4. The cursor's `typeof parsed !== 'object'`. A string or an array payload
 *     reaches `obj.last_started_at`, gets `undefined`, and fails the number
 *     check on the next line.
 *  5. The cursor's `raw.length === 0`. An empty token decodes to an empty
 *     string and `JSON.parse('')` throws into the catch, returning the same
 *     null.
 *  6. `csvEscape`'s null/undefined branch and its `JSON.stringify` fallback.
 *     Nine of the nine call sites in `csvRow` apply `?? ''` FIRST, so neither
 *     branch is reachable from the row builder; both are defence for a future
 *     caller.
 * ────────────────────────────────────────────────────────────────────────── */

