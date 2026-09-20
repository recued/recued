/** One CSV cell serializer, shared by every surface that emits CSV.
 *
 *  ⛔⛔ WHY THIS IS SHARED RATHER THAN OBVIOUS. Four surfaces wrote their own
 *  escaper — `form-response-handler.ts`, `audit-export.ts`, `records/store.ts`
 *  and `transforms/display.ts` — and TWO of them were even called `csvCell`.
 *  Only one neutralised spreadsheet formulas. The other three did RFC-4180
 *  quoting and stopped, because quoting LOOKS like the whole job.
 *
 *  ⛔ IT IS NOT. Quoting and formula-neutralisation are different layers with
 *  different audiences:
 *
 *    - Quoting serves the PARSER. It makes field boundaries unambiguous, so a
 *      cell containing the delimiter, a quote or a newline survives the trip.
 *    - Formula evaluation happens AFTER parsing, in the APPLICATION. Excel,
 *      Sheets and LibreOffice strip the quotes, look at the resulting VALUE,
 *      and if it begins with `=`, `+`, `-` or `@` they evaluate it as a
 *      formula. `"=HYPERLINK(""http://x"",""go"")"` is a perfectly quoted cell
 *      and still a live formula.
 *
 *  ⇒ Quoting cannot disarm a formula, and adding `=` to an escape regex does
 *  nothing at all. The only thing that works is changing the VALUE, which is
 *  what the leading apostrophe does: spreadsheets read `'` as "the rest of this
 *  cell is text".
 *
 *  🔑 THE RULE IS LIFTED VERBATIM FROM `form-response-handler.ts`, which got
 *  there first and for the best reason — its cells carry text OTHER PEOPLE
 *  submitted through a form. Keeping the regex byte-identical is deliberate:
 *  four surfaces agreeing is the point, and "improving" it here would make this
 *  the fifth variant.
 *
 *  ⚠ `^\s*` MATTERS. A leading space before the `=` still evaluates in some
 *  applications, so the trigger is sought past any leading whitespace.
 *
 *  ⚠ WHAT THIS DOES NOT OWN: turning a value into a string. The callers
 *  legitimately differ — one canonicalises objects for a stable hash, another
 *  wants `JSON.stringify`, a third already holds a string. Unifying the
 *  ESCAPING is the shared concern; unifying the RENDERING would force three
 *  surfaces to change what their cells contain. */

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEAD = /^\s*[=+\-@]/;

export interface CsvCellOptions {
  /** Field separator this file uses. Default `,`. A cell containing it is
   *  quoted; pass the real delimiter or the quoting under-triggers. */
  readonly delimiter?: string;
  /** Quote every cell rather than only the ones that need it. Some surfaces
   *  emit uniformly-quoted rows; preserved per-caller so adopting this helper
   *  changes ONLY the neutralisation, never the shape of existing output. */
  readonly alwaysQuote?: boolean;
}

/** Neutralise a formula-looking value, then RFC-4180 quote it.
 *
 *  ⚠ ORDER IS LOAD-BEARING: the prefix changes the value, so the quoting
 *  decision is made on the FINAL text. Reversed, a neutralised cell containing
 *  a delimiter would escape the pre-prefix string and split the row. */
export const csvCell = (text: string, options: CsvCellOptions = {}): string => {
  const delimiter = options.delimiter ?? ',';
  const value = FORMULA_LEAD.test(text) ? `'${text}` : text;
  const mustQuote =
    options.alwaysQuote === true
    || value.includes(delimiter)
    || /["\r\n]/.test(value);
  return mustQuote ? `"${value.replace(/"/g, '""')}"` : value;
};
