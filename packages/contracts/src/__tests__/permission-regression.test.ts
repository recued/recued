import { expect, it } from 'vitest';
import { parsePermissionDocument, PERMISSION_REGRESSION_LIMITS } from '../permission-regression.js';
import { isReservedLocalRpc } from '../mcp-tool-catalog.js';
const document = () => ({ title: 'Permission checks', changes: [{ entry_key: 'data.mail', granted: false }], cases: [
  { id: 'mail', name: 'Mail withheld', credential_id: 'credential', expected: 'deny', target: { kind: 'collection', collection: 'mail' } },
] });
it('keeps every owner workbench method outside MCP', () => {
  for (const method of ['get', 'save', 'restore', 'test', 'prepare', 'activate', 'delete']) expect(isReservedLocalRpc('contract.regression.' + method)).toBe(true);
});
it('rejects forged principal, proof and result fields and bounds retained example input', () => {
  expect(parsePermissionDocument(document())).toEqual(document());
  for (const key of ['source', 'authority', 'qualification', 'outcome']) expect(() => parsePermissionDocument({ ...document(), [key]: true })).toThrow();
  const duplicate = document(); duplicate.cases.push(duplicate.cases[0]!); expect(() => parsePermissionDocument(duplicate)).toThrow();
  const large = document(); large.title = 'x'.repeat(PERMISSION_REGRESSION_LIMITS.document_bytes + 1); expect(() => parsePermissionDocument(large)).toThrow();
});
