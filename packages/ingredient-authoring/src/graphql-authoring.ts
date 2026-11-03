const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A dotted legacy diagnostic cannot identify which operation owns a prefix.
 * Include every lowered name, even malformed/dangling bindings, before joining. */
const uniqueLegacyOwner = (names: Set<string>, address: string, expected: string) => {
  let end = address.indexOf('.');
  while (end >= 0) {
    const prefix = address.slice(0, end); if (prefix !== expected && names.has(prefix)) return false;
    end = address.indexOf('.', end + 1);
  }
  return address === expected || !names.has(address);
};
/** Project existing findings through the exact lowered binding; never parse messages.
 * Duplicate operation identities and colliding legacy paths have no guessed owner. */
export const graphqlIssueLocations = (operations: unknown, executes: unknown, catalogOperations: unknown): Map<string, string> => {
  const candidates = new Map<string, string[]>();
  if (!Array.isArray(operations) || !object(executes) || !object(catalogOperations)) return new Map();
  const counts = new Map<string, number>();
  const bindingNames = new Set(Object.keys(executes)), operationNames = new Set(Object.keys(catalogOperations));
  for (const row of operations) if (object(row) && typeof row.op === 'string') counts.set(row.op, (counts.get(row.op) ?? 0) + 1);
  const add = (code: string, path: string, target: string) => { const key = JSON.stringify([code, path]); candidates.set(key, [...(candidates.get(key) ?? []), target]); };
  for (const [index, row] of operations.entries()) {
    if (!object(row) || typeof row.op !== 'string' || !object(row.bind) || row.bind.kind !== 'graphql'
      || counts.get(row.op) !== 1 || !Object.hasOwn(executes, row.op) || executes[row.op] !== row.bind) continue;
    for (const field of ['operation_type', 'query', 'endpoint_path', 'result_data_path']) {
      if (!uniqueLegacyOwner(bindingNames, row.op + '.' + field, row.op)) continue;
      add('CATALOG_BINDING_INVALID', 'surfaces.api.executes.' + row.op + '.' + field, 'operations[' + index + '].bind.' + field);
      if (field === 'query' || field === 'operation_type') add('CATALOG_BINDING_RISK_MISMATCH', 'surfaces.api.executes.' + row.op + '.' + field, 'operations[' + index + '].bind.' + field);
    }
    const spec = Object.hasOwn(catalogOperations, row.op) ? catalogOperations[row.op] : undefined;
    if (object(spec) && spec.risk_tier === row.risk && uniqueLegacyOwner(operationNames, row.op + '.risk_tier', row.op)) add('CATALOG_BINDING_RISK_MISMATCH', 'operations.' + row.op + '.risk_tier', 'operations[' + index + '].risk');
  }
  return new Map([...candidates].filter(([, paths]) => paths.length === 1).map(([key, paths]) => [key, paths[0]!]));
};
