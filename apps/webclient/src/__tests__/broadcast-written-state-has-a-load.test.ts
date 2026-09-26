/** Every state field a broadcast writes must also be populated by a load.
 *
 *  ⛔ THE DEFECT THIS EXISTS FOR, TWICE IN ONE PANEL. A field written only
 *  inside a `subscribe('<kind>', …)` callback holds its initial value on every
 *  fresh mount, so whatever renders from it is dark after a reload — however
 *  long the underlying state has stood on the server. Measured live: the drift
 *  banner rendered once and was gone after a reload in the same tab (D-285),
 *  and the promotion banner never rendered after a reload at all, while
 *  `promotion_suggested_at` sat on trust rows the panel had just fetched.
 *
 *  ⚠ "Has another writer" is NOT the rule, and that mistake is why the first
 *  sweep found nothing: both defective fields DID have other writers — a
 *  dismissal and an accept-action. A remover and a local edit are writers. The
 *  rule is that something must POPULATE the field from loaded state.
 *
 *  🔑 A test cannot decide what a "load" is, so it does not try. It requires
 *  the author to NAME the populating function, and then verifies that function
 *  really writes the field — so a declaration cannot rot into a comment. A new
 *  broadcast-written field fails this test until someone says where it is
 *  restored from, which is the conversation the rule exists to force. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

/** Where each broadcast-written field is restored from on a fresh mount.
 *
 *  Key: `<file basename>::<field>`. Value: the function that populates it.
 *  ⛔ Adding an entry is a claim the test checks — the named function must
 *  actually write that field. */
const POPULATED_BY: Record<string, string> = {
  'housekeeping-panel-mount.ts::driftSignals': 'doLoadDrift',
  'housekeeping-panel-mount.ts::promotionSuggestions': 'doLoad',
};

// ── the parser ───────────────────────────────────────────────────────
// Deliberately small, and pinned by the fixtures below: three earlier
// versions of it silently found NOTHING, which reads exactly like a clean
// codebase. A detector with no control is a false all-clear generator.

/** Blank out comments, preserving LENGTH so every offset still lines up.
 *
 *  ⛔ Not cosmetic. A comment between two properties —
 *  `trustRows,` / `// …` / `promotionSuggestions:` — lands in the key buffer
 *  and makes the key fail its identifier check, so the parser silently lost a
 *  `doLoad` writer and reported an already-restored field as broadcast-only.
 *  Length is preserved because `subscribeRanges` and `setStateSites` are
 *  compared by offset; rewriting lengths would misalign them. */
export const blankComments = (src: string): string => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    const c = src[i]!;
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end;
    } else if (two === '/*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (src[j] === '\\') { j += 1; continue; }
        if (src[j] === quote) break;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
};

/** Byte ranges of every `subscribe('kind', …)` callback. */
export const subscribeRanges = (
  src: string,
): Array<{ kind: string; start: number; end: number }> => {
  const out: Array<{ kind: string; start: number; end: number }> = [];
  const re = /subscribe\(\s*'([a-zA-Z0-9_.]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    let depth = 0;
    let started = false;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(') { depth += 1; started = true; }
      else if (c === ')') { depth -= 1; if (started && depth < 0) break; }
    }
    out.push({ kind: m[1]!, start: m.index, end: i });
  }
  return out;
};

/** Top-level keys of the object literal passed to each `setState(...)`.
 *  ⚠ Shorthand counts — `setState({ driftSignals })` names a field just as
 *  loudly as `driftSignals: x`, and missing it reported a FIXED field as
 *  broken. */
export const setStateSites = (
  src: string,
): Array<{ start: number; keys: string[] }> => {
  const out: Array<{ start: number; keys: string[] }> = [];
  const re = /setState\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex - 1;
    let depth = 0;
    let buf = '';
    const keys: string[] = [];
    const flush = (): void => {
      const k = buf.trim();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) keys.push(k);
      buf = '';
    };
    for (; i < src.length; i += 1) {
      const c = src[i]!;
      if (c === '{' || c === '(' || c === '[') {
        depth += 1;
        if (depth === 1) { buf = ''; continue; }
      } else if (c === '}' || c === ')' || c === ']') {
        if (depth === 1 && c === '}') flush();
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth === 1) {
        if (c === ',') { flush(); continue; }
        if (c === ':') {
          flush();
          let vd = 0;
          for (i += 1; i < src.length; i += 1) {
            const d = src[i]!;
            if (d === '{' || d === '(' || d === '[') vd += 1;
            else if (d === '}' || d === ')' || d === ']') { if (vd === 0) { i -= 1; break; } vd -= 1; }
            else if (d === ',' && vd === 0) break;
          }
          continue;
        }
        buf += c;
      }
    }
    out.push({ start: m.index, keys });
  }
  return out;
};

/** Nearest preceding FUNCTION definition — not merely the nearest `const`,
 *  which reported locals like `captured` as writers. */
export const enclosingFunction = (src: string, at: number): string => {
  const head = src.slice(0, at);
  const names = [
    ...head.matchAll(
      /(?:^|\n)\s*(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)[^=\n]*=\s*(?:async\s*)?\(|(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    ),
  ].map((x) => x[1] ?? x[2]);
  return names.length > 0 ? names[names.length - 1]! : '<top level>';
};

interface FieldWriters { kinds: Set<string>; byFunction: Set<string> }

const analyse = (raw: string): Map<string, FieldWriters> => {
  const src = blankComments(raw);
  const ranges = subscribeRanges(src);
  const out = new Map<string, FieldWriters>();
  if (ranges.length === 0) return out;
  for (const site of setStateSites(src)) {
    const inBroadcast = ranges.find((r) => site.start > r.start && site.start < r.end);
    for (const field of site.keys) {
      const e = out.get(field) ?? { kinds: new Set<string>(), byFunction: new Set<string>() };
      if (inBroadcast) e.kinds.add(inBroadcast.kind);
      else e.byFunction.add(enclosingFunction(src, site.start));
      out.set(field, e);
    }
  }
  return out;
};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...walk(p));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
};

// ── the detector's own controls ──────────────────────────────────────

describe('the detector can tell the two cases apart', () => {
  const BROADCAST_ONLY = `
    const doDismiss = (topic: string): void => {
      setState({ signals: omitKey(state.signals, topic) });
    };
    opts.subscribe('thing_happened', (event) => {
      setState({ signals: { ...state.signals, [event.topic]: event } });
    });
  `;
  const WITH_A_LOAD = `
    const doLoadSignals = async (): Promise<void> => {
      const res = await opts.runRead();
      setState({ signals: res.rows });
    };
    opts.subscribe('thing_happened', (event) => {
      setState({ signals: { ...state.signals, [event.topic]: event } });
    });
  `;

  it('flags a field whose only other writer is an action', () => {
    const w = analyse(BROADCAST_ONLY).get('signals')!;
    expect([...w.kinds]).toEqual(['thing_happened']);
    expect([...w.byFunction]).toEqual(['doDismiss']);
  });

  it('sees the load that clears it', () => {
    const w = analyse(WITH_A_LOAD).get('signals')!;
    expect(w.byFunction.has('doLoadSignals')).toBe(true);
  });

  it('sees SHORTHAND, including as the last property', () => {
    // ⛔ Both forms were missed by earlier versions, and each miss turned a
    // fixed field back into a false positive.
    const trailing = analyse(`
      const doLoadThings = async (): Promise<void> => { setState({ things }); };
      opts.subscribe('thing_happened', () => { setState({ things: 1 }); });
    `);
    expect(trailing.get('things')!.byFunction.has('doLoadThings')).toBe(true);

    const commaed = analyse(`
      const doLoadThings = async (): Promise<void> => { setState({ things, other: 2 }); };
      opts.subscribe('thing_happened', () => { setState({ things: 1 }); });
    `);
    expect(commaed.get('things')!.byFunction.has('doLoadThings')).toBe(true);
  });

  it('sees a key that a COMMENT sits in front of', () => {
    // ⛔ The real shape that broke this: a comment between two properties put
    // itself in the key buffer, and the `doLoad` writer vanished — turning a
    // restored field back into a reported defect.
    const w = analyse(`
      const doLoadThings = async (): Promise<void> => {
        setState({
          other: 1,
          // a note about why the next line is the way it is
          things: 2,
        });
      };
      opts.subscribe('thing_happened', () => { setState({ things: 3 }); });
    `);
    expect(w.get('things')!.byFunction.has('doLoadThings')).toBe(true);
  });

  it('does not mistake a nearby local for the writing function', () => {
    const w = analyse(`
      const doLoadThings = async (): Promise<void> => {
        const captured = 1;
        setState({ things: captured });
      };
      opts.subscribe('thing_happened', () => { setState({ things: 1 }); });
    `);
    expect([...w.get('things')!.byFunction]).toEqual(['doLoadThings']);
  });

  it('finds nothing when nothing subscribes — no false alarm on a plain mount', () => {
    expect(analyse('const doLoad = async (): Promise<void> => { setState({ a: 1 }); };').size).toBe(0);
  });
});

// ── the rule ─────────────────────────────────────────────────────────

describe('broadcast-written state is restorable on a fresh mount', () => {
  const found: Array<{ file: string; field: string; kinds: string[]; byFunction: string[] }> = [];
  for (const file of walk(SRC)) {
    for (const [field, w] of analyse(readFileSync(file, 'utf8'))) {
      if (w.kinds.size === 0) continue;
      found.push({
        file: relative(SRC, file),
        field,
        kinds: [...w.kinds],
        byFunction: [...w.byFunction],
      });
    }
  }

  it('finds the fields it is meant to police — the scan is not vacuous', () => {
    // If this ever reads 0, the parser has gone blind rather than the client
    // having become clean. Three earlier versions did exactly that.
    expect(found.length).toBeGreaterThan(0);
  });

  it('every broadcast-written field names where a fresh mount restores it', () => {
    const undeclared = found
      .filter((f) => POPULATED_BY[`${f.file.split('/').pop()!}::${f.field}`] === undefined)
      .map((f) => `${f.file} :: ${f.field} (written by ${f.kinds.join(', ')}; `
        + `other writers: ${f.byFunction.join(', ') || 'NONE'})`);

    expect(undeclared, [
      'A broadcast is a moment; a mount outlives it.',
      'Each field above is written by a broadcast handler and has no declared',
      'populating writer, so a reload leaves whatever renders from it dark.',
      'Either restore it from a load and add an entry to POPULATED_BY, or',
      'trigger a re-read from the handler instead of painting state directly.',
    ].join('\n')).toEqual([]);
  });

  it('each declared populating writer really writes its field', () => {
    // A declaration that stops being true is worse than none: it reads as
    // coverage while the field is once again broadcast-only.
    const broken = Object.entries(POPULATED_BY).filter(([key, fn]) => {
      const [basename, field] = key.split('::');
      const hit = found.find((f) => f.file.split('/').pop() === basename && f.field === field);
      return hit === undefined || !hit.byFunction.includes(fn!);
    });
    expect(broken).toEqual([]);
  });
});
