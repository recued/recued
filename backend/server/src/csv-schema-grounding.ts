/** Column selectors name schema, not record values. Keep in sync with the bench twin. */
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : null;
const csvTool = /^(?:recued-core\/)?(?:select-csv-columns|filter-csv-rows|concatenate-csv-files|join-csv-files|diff-csv-files|aggregate-csv-rows|map-csv-columns|sort-csv-rows|deduplicate-csv-rows)$/;

/** Read only the bounded first CSV record, including quoted/escaped headers.
 * A partial first page cannot attest a header without its record terminator. */
const csvHeader = (text: string, delimiter: string, complete: boolean): string[] | null => {
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) return null;
  const columns: string[] = []; let cell = '', quoted = false, closed = false;
  const finish = (): string[] | null => {
    const result = [...columns, cell];
    return result.length <= 256 && result.every(name => name.length > 0)
      && new Set(result).size === result.length ? result : null;
  };
  let i = text.startsWith('\uFEFF') ? 1 : 0;
  for (; i < text.length && i < 8192; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === delimiter) { columns.push(cell); cell = ''; closed = false; }
    else if (char === '\r' || char === '\n') return finish();
    else if (char === '"' && !closed && cell === '') quoted = true;
    else if (char === '"' || closed) return null;
    else cell += char;
  }
  return complete && i === text.length && !quoted ? finish() : null;
};

export const isCsvSchemaArgument = (tool: string, args: unknown, path: string, value: string, packet: string): boolean => {
  let input = object(args); if (!input) return false;
  if (tool === 'recipe.run') {
    tool = typeof input.recipe_id === 'string' ? input.recipe_id : '';
    input = object(input.config); if (!input || !path.startsWith('config.')) return false;
    path = path.slice(7);
  }
  if (!csvTool.test(tool)) return false;
  // Output names are authored schema. The file operation validates uniqueness.
  if (/^(?:names\[\d+\]|(?:aggregations|mappings)\[\d+\]\.as)$/.test(path)) return true;
  const expressionColumn = /^mappings\[\d+\]\.expression(?:\.(?:input|left|right)|\.values\[\d+\])*\.column$/.test(path);
  const right = /^right_keys\[\d+\]$/.test(path);
  if (!right && !expressionColumn && !/^(?:columns\[\d+\]|left_keys\[\d+\]|keys\[\d+\]|group_by\[\d+\]|compare_columns\[\d+\]|conditions\[\d+\]\.column|aggregations\[\d+\]\.column|by\[\d+\]\.column)$/.test(path)) return false;
  const source = right ? input.other_source : input.source;
  if (typeof source !== 'string') return false;
  const delimiter = (right ? input.other_delimiter : input.delimiter) ?? ',';
  let body: ObjectValue | null;
  try {
    body = object(JSON.parse(packet));
    if (typeof body?.prompt === 'string') body = object(JSON.parse(body.prompt));
  } catch { return false; }
  return Array.isArray(body?.prior_tool_calls) && body.prior_tool_calls.some((raw: unknown) => {
    const call = object(raw), result = object(call?.result);
    if (call?.status !== 'ok' || !result) return false;
    if (call.tool_name === 'document.read' && result.status === 'read' && result.converter === 'text'
      && result.offset === 0 && result.file_ref === source && typeof result.body === 'string'
      && typeof result.content_hash === 'string' && /^[a-f0-9]{64}$/.test(result.content_hash) && typeof delimiter === 'string') {
      return csvHeader(result.body, delimiter, result.next_offset === null && result.text_incomplete === false)?.includes(value) === true;
    }
    const output = object(result.output);
    if (result.success !== true || !Array.isArray(output?.render)) return false;
    return output.render.some((rawPart: unknown) => {
      const part = object(rawPart), data = object(part?.data);
      return part?.type === 'json' && Array.isArray(data?.columns) && data.columns.includes(value)
        && (data.file_ref === source || object(data.source)?.file_ref === source);
    });
  });
};
