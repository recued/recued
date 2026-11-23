/** D-402 slice B2b — the values a chat's answer gave (§3.1), so the recipe can read each out of the page
 *  that showed it (§4, rule 7). The owner's chat answers in prose, so what it set apart is taken: a
 *  table's cells (not its header), a list item (after its label, when it has one), bold text and quoted
 *  text; and (slice B4, from the benchmark's answers) a short complement ending a sentence ("… is Women
 *  in STEM fields.", "… was said by C.S. Lewis.", "Its tags are: books, …") and a count with its unit
 *  ("1288 points"). A value the request already said is
 *  context, not an answer ("the last article under “See also”"), and is left out. Each at most 200
 *  characters; at most 20. */

const MAX_VALUES = 20;
const strip = (value: string): string => value.replace(/\*\*|__|`/gu, '').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
  .replace(/\s+/gu, ' ').trim();
const usable = (value: string): boolean => value.length >= 2 && value.length <= 200 && /[\p{L}\p{N}]/u.test(value);

const plain = (value: string): string => value.toLowerCase().replace(/["'“”‘’]/gu, '').replace(/\s+/gu, ' ').trim();

/** A character of a complement: none that ends a sentence, but a full stop inside a word or number
 *  ("C.S", "3.5") and one after an initial ("C. S. Lewis"). */
const COMPLEMENT_CHAR = String.raw`(?:[^.!?\n"“”]|\.(?=[\p{L}\p{N}])|(?<=(?:^|[\s.])\p{Lu})\.)`;
const COMPLEMENT = new RegExp(String.raw`\b(?:is|are|was|were):?\s+(${COMPLEMENT_CHAR}{2,60})[.!?](?:\s|$)`, 'gu');

export const answerValuesOf = (reply: string, request?: string): string[] => {
  const values: string[] = [];
  const asked = request === undefined ? '' : plain(request);
  const add = (raw: string): void => {
    const value = strip(raw).replace(/^[“"']|[”"']$/gu, '').trim();
    if (asked !== '' && asked.includes(plain(value))) return;
    if (usable(value) && !values.includes(value) && values.length < MAX_VALUES) values.push(value);
  };
  const lines = reply.split(/\r?\n/u);
  let tableRow = 0;
  for (const line of lines) {
    const row = line.trim();
    if (row.startsWith('|')) {
      tableRow += 1;
      if (/^\|[\s:|-]+\|?$/u.test(row) || tableRow === 1) continue;
      for (const cell of row.split('|').slice(1, -1)) add(cell);
      continue;
    }
    tableRow = 0;
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(row);
    if (item !== null) {
      const text = item[1]!;
      const labelled = /^(?:\*\*[^*]+\*\*|[^:]{1,40}):\s+(.+)$/u.exec(text);
      add(labelled !== null ? labelled[1]! : text);
    }
  }
  for (const match of reply.matchAll(/\*\*([^*\n]{2,200})\*\*/gu)) add(match[1]!);
  for (const match of reply.matchAll(/[“"]([^”"\n]{2,200})[”"]/gu)) add(match[1]!);
  // A short complement that ends a sentence, with no quotes in it: "… is Women in STEM fields."
  // 2026-11-20 (task H) — with its initials and decimals ("C.S. Lewis", "C. S. Lewis", "3.5"); after a
  // colon too ("Its tags are: books, …"); and of "<done> by <whom>", whom ("was said by C.S. Lewis").
  for (const match of reply.matchAll(COMPLEMENT)) {
    const complement = match[1]!.trim();
    if (/^(?:a|an|the|not|no|one|about|around)\b/iu.test(complement)) continue;
    const value = /^\p{L}+\s+by\s+(.{2,})$/u.exec(complement)?.[1] ?? complement;
    // An initial a space follows is a name's only when the whole is one ("C. S. Lewis"), not a
    // sentence that ended on a letter ("… is B. The next one is C.").
    if (/(?:^|[\s.])\p{Lu}\.\s/u.test(value) && !/^(?:\p{Lu}[\p{L}'’.-]*\s*)+$/u.test(value)) continue;
    add(value);
  }
  // A count with its unit: "1288 points".
  for (const match of reply.matchAll(/\b(\d[\d,.]*\s(?:points?|comments?|votes?|stars?|reviews?|results?|items?|books?|quotes?|pages?))\b/giu)) {
    add(match[1]!);
  }
  return values;
};
