import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RECORDS_MAX_BATCH_OPS } from "@recued/contracts";
import { TRANSFORMS } from "@recued/transforms";
import { describe, expect, it } from "vitest";

/** ⛔⛔⛔ DRIVEN AGAINST A REAL BANK EXPORT, BECAUSE THE AUDIT TEST COULD NOT SEE THIS.
 *
 *  `statement-import-pack-audit` asserts the unusable-row filter exists and runs BEFORE
 *  the write. Both were true, and the recipe was still wrong: real bank CSVs quote their
 *  amounts with thousands separators (`"3,391.02"`), `to_number` is `Number(input)` which
 *  returns NaN → null for those, and `null - 0` is **0, not null** — so the
 *  `amount is_not_null` guard caught NOTHING. 1000 of 1000 rows "survived" it and 663
 *  were imported as silent zeros. The net came out a plausible 22,302.42 against a true
 *  151,193.70.
 *
 *  🔑 THE LESSON IS THE ARITHMETIC, NOT THE SEPARATOR. A null that flows through a
 *  subtraction becomes a legitimate-looking zero, so a null-check downstream of the maths
 *  is structurally unable to fire. That is why this test asserts the NET against an
 *  independently computed figure rather than asserting the pipeline's shape — a shape
 *  assertion passed the whole time the numbers were wrong.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = resolve(HERE, "../../../../..", "sample_data/1000-BT-Records.csv");

const reg = TRANSFORMS as unknown as Map<string, (p: Record<string, unknown>, c: unknown) => unknown>;
const get = (n: string) => reg.get(n)!;
const ctx = { getTransform: get };
const run = <T,>(name: string, params: Record<string, unknown>): T =>
  get(name)(params, ctx) as T;

/** ⚠ Skipped rather than failed when the sample is absent: it is developer sample data,
 *  not a repo artifact, and a hard failure here would redden the suite for everyone who
 *  does not have it. The `expect` inside still runs for anyone who does. */
const maybe = existsSync(CSV) ? it : it.skip;

describe("statement import — driven against a real bank export", () => {
  maybe("⛔⛔⛔ the imported net matches an INDEPENDENT sum of the file", () => {
    const csv = readFileSync(CSV, "utf8");

    /** The recipe's chain for the debit/credit layout, with this bank's real column
     *  names — note `Withdrawls`, misspelled in the export, which is exactly why the
     *  mapping is config-driven rather than inferred. */
    const parsed = run<Record<string, string>[]>("csv_parse", {
      input: csv, delimiter: ",", ragged: "skip",
    });
    expect(parsed.length, "the sample must parse").toBe(1000);

    const sep = ",";
    const stripDebit = run("map", { array: parsed, apply: "replace", field: "Withdrawls", pattern: sep, replacement: "", all: true, output_field: "debit_s" });
    const stripCredit = run("map", { array: stripDebit, apply: "replace", field: "Deposits", pattern: sep, replacement: "", all: true, output_field: "credit_s" });
    const debit = run("map", { array: stripCredit, apply: "to_number", field: "debit_s", output_field: "debit_n" });
    const credit = run("map", { array: debit, apply: "to_number", field: "credit_s", output_field: "credit_n" });
    const priced = run<Record<string, unknown>[]>("map", {
      array: credit, expression: "{{item.credit_n}} - {{item.debit_n}}", output_field: "amount",
    });

    /** ⛔ THE INDEPENDENT FIGURE — computed straight from the file, not from the chain.
     *  Comparing the chain to itself is how a wrong pipeline certifies itself. */
    const raw = (s: string): number => Number((s ?? "").replaceAll(",", "").trim() || 0);
    const expectedNet = parsed.reduce((n, r) => n + raw(r.Deposits!) - raw(r.Withdrawls!), 0);

    const net = run<number>("sum", { array: priced, field: "amount" });
    expect(net).toBeCloseTo(expectedNet, 2);
    expect(net).toBeCloseTo(151_193.70, 2);

    /** ⛔⛔ THE ASSERTION THAT ACTUALLY CATCHES THE BUG. Before the fix this was 337 —
     *  663 rows silently became zero and every shape assertion still passed. A near-total
     *  non-zero count is the shape of a correct parse; a collapsed one is the shape of a
     *  separator eaten by `Number()`. */
    const nonZero = priced.filter((r) => Number(r.amount) !== 0).length;
    expect(nonZero, "a separator-eating parse collapses this count").toBe(999);

    /** ⚠ And exactly one row is GENUINELY zero (00.00 / 00.00 on 12-Sep-2020), so the
     *  count above is pinned to 999 rather than 1000 — asserting 1000 would force a
     *  future fix to discard a real, legitimate zero-value transaction. */
    const zeros = priced.filter((r) => Number(r.amount) === 0);
    expect(zeros).toHaveLength(1);
    expect((zeros[0] as { Description?: string }).Description).toBe("RTGS");
  });

  maybe("⛔⛔ 1000 real rows become 10 batch calls, with every row carried", () => {
    /** The concrete payoff of the D-226 switch, measured on the real file rather than a
     *  synthetic array: 1000 individual `line.create` dispatches — each one a gateway
     *  round trip, a transaction and an audit entry against quota'd, oldest-first-evicting
     *  audit (D-230) — become 10 `line.batch` calls.
     *
     *  ⛔ THE COUNT ALONE WOULD NOT CATCH A LOST ROW. A chunker that dropped or duplicated
     *  a run still yields a plausible 10, and for financial records that is the failure
     *  that reads as success. So the ops are flattened and compared for identity. */
    const csv = readFileSync(CSV, "utf8");
    const parsed = run<Record<string, string>[]>("csv_parse", { input: csv, delimiter: ",", ragged: "skip" });

    const lineOps = run<unknown[]>("map", {
      array: parsed,
      expression: { entity: "statement_line", action: "create", args: { values: { description: "{{item.Description}}" } } },
    });
    const batches = run<unknown[][]>("chunk", { array: lineOps, size: RECORDS_MAX_BATCH_OPS });

    expect(batches).toHaveLength(Math.ceil(1000 / RECORDS_MAX_BATCH_OPS));
    expect(batches.flat(), "every row must survive the chunking").toHaveLength(1000);
    expect(batches.every((b) => b.length <= RECORDS_MAX_BATCH_OPS),
      "no chunk may exceed the cap the records layer enforces").toBe(true);
    /** ⚠ And each entry is a DECLARED op, not a bare row — the batch action refuses
     *  anything whose entity/action pair the op did not declare, so a projection that
     *  lost the envelope would fail at the store rather than here. */
    expect(batches[0]![0]).toMatchObject({ entity: "statement_line", action: "create" });
  });

  maybe("⛔ the null-through-subtraction hazard is real, and is what defeated the guard", () => {
    /** Pinned as its own case because the FIX (stripping separators) and the HAZARD
     *  (null arithmetic silently yielding zero) are separate things. A future change that
     *  reintroduced an unparseable value would hit this same trap, and a reader needs to
     *  see why an `is_not_null` filter downstream of the maths cannot save them. */
    const unparseable = run<number | null>("to_number", { input: "3,391.02" });
    expect(unparseable, "Number() cannot read a thousands separator").toBeNull();

    const throughMaths = run<Record<string, unknown>[]>("map", {
      array: [{ credit_n: unparseable, debit_n: 0 }],
      expression: "{{item.credit_n}} - {{item.debit_n}}",
      output_field: "amount",
    });
    expect(throughMaths[0]!.amount, "null - 0 becomes a legitimate-looking ZERO").toBe(0);

    const survived = run<unknown[]>("filter", {
      array: throughMaths, field: "amount", operator: "is_not_null",
    });
    expect(survived, "which is why the null guard could never fire").toHaveLength(1);
  });
});
