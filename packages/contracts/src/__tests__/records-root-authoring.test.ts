import { describe, expect, it } from 'vitest';
import { recordsRootRoute, recordsRootProjectionIssues, recordsRootProjectionNameIssues, validateRecordsRootProjection, validateRecordsRootProjectionNames } from '../records-root-projection.js';

const entities = {entry: {fields: [{key: 'ticket', kind: 'ref'}, {key: 'value', kind: 'number'}, {key: 'state', kind: 'string'}]},
  ticket: {fields: [{key: 'account', kind: 'ref'}]}, account: {fields: [{key: 'email', kind: 'string'}]}};
const fixture = () => ({root: 'contact', via: [{field: 'ticket', entity: 'ticket'}, {field: 'account', entity: 'account'}], key_field: 'email', select: {total: {fn: 'sum', field: 'value'}}});
describe('shared root projection authoring contracts', () => {
  it('shares the bounded route and preserves valid and invalid legacy messages with exact relative paths', () => {
    const root = fixture(); expect(validateRecordsRootProjection(root, 'entry', entities)).toEqual([]);
    expect(recordsRootRoute(root.via.slice(0, 1), 'entry', entities).entity).toBe('ticket');
    expect(recordsRootRoute(root.via, 'entry', entities).entity).toBe('account');
    root.key_field = 'missing';
    expect(recordsRootProjectionIssues(root, 'entry', entities)).toEqual([{path: ['key_field'], message: "roots[0].key_field: 'missing' is not a field of 'account'"}]);
    expect(validateRecordsRootProjection(root, 'entry', entities)).toEqual(["roots[0].key_field: 'missing' is not a field of 'account'"]);
    root.via[1]!.field = 'missing'; expect(recordsRootProjectionIssues(root, 'entry', entities)[0]!.path).toEqual(['via', 1, 'field']);
    root.via.push(root.via[0]!); expect(recordsRootRoute(root.via, 'entry', entities).issues[0]!.path).toEqual(['via']);
  });
  it('locates select, predicate and pack-wide naming findings without parsing their messages', () => {
    const root = {...fixture(), select: {'bad.name': {fn: 'summ'}}, where: {'missing.field': true}};
    const issues = recordsRootProjectionIssues(root, 'entry', entities);
    expect(issues.map(row => row.path)).toEqual([['select', 'bad.name'], ['select', 'bad.name', 'fn'], ['where', 'missing.field']]);
    expect(issues[0]!.target).toBe('key'); expect(issues[2]!.target).toBe('key');
    expect(issues.map(row => row.message)).toEqual(validateRecordsRootProjection(root, 'entry', entities));
    const names = [{path: 'a.roots[0]', projection: {...root, name: 'total'}}, {path: 'b.roots[1]', projection: {...root, name: 'total'}}, {path: 'c.roots[0]', projection: root}];
    const conflicts = recordsRootProjectionNameIssues(names);
    expect(conflicts.map(row => [row.index, row.path])).toEqual([[1, ['name']], [2, ['name']]]);
    expect(conflicts.map(row => row.message)).toEqual(validateRecordsRootProjectionNames(names));
  });
  it('refuses inherited entity and predicate names and handles a missing base entity without throwing', () => {
    const root = fixture(); root.via[0]!.entity = 'constructor';
    expect(recordsRootRoute(root.via, 'entry', entities).issues[0]!.path).toEqual(['via', 0, 'entity']);
    expect(recordsRootProjectionIssues({...fixture(), via: []}, 'missing', entities)[0]!.message).toContain('unknown base entity');
    const issues = recordsRootProjectionIssues({...fixture(), where: {constructor: true}}, 'entry', entities);
    expect(issues).toEqual([{path: ['where', 'constructor'], target: 'key', message: "roots[0].where: unknown field 'constructor'"}]);
  });
});
