/** A dotted `body.<path>` field nests in a JSON body.
 *
 *  ⛔⛔ THE DEFECT THIS CLOSES. `buildConnectionApiBody` split only the first `body.`
 *  segment, so `body.properties.hs_next_step` went out as the flat key
 *  `{"properties.hs_next_step": …}`. HubSpot answers that with 400 "No properties found to
 *  update" (checked against HubSpot itself, 2026-11-02), and 415 operations in 71 shipped packs
 *  declare a nested field this way (`body.amount.currency`, `body.data.attributes.email`,
 *  `body.fields.summary`). Found by a live HubSpot deal update (D-337 §7.23).
 *
 *  ⚠ The rule has two exceptions, each from a shipped pack: a FORM body keeps its names
 *  (Twilio's `Parameter1.Name` is one form field), and an OData annotation is one key though it
 *  has a dot in it (Microsoft Entra's `body.@odata.id`). */
import { describe, expect, it } from 'vitest';

import { IngredientError } from '../types.js';
import { buildConnectionApiBody } from '../connection-api.js';

const headers = (init?: Record<string, string>): Headers => new Headers(init);
const json = (params: Record<string, unknown>): unknown =>
  JSON.parse(buildConnectionApiBody(params, headers())!);

describe('connection.api nests a dotted body field in a JSON body', () => {
  it('sends HubSpot its properties object', () => {
    expect(buildConnectionApiBody({
      'body.properties.hs_next_step': 'Call back on Friday',
      'body.properties.amount': '10',
    }, headers())).toBe('{"properties":{"hs_next_step":"Call back on Friday","amount":"10"}}');
  });

  it('nests as deep as the name goes', () => {
    expect(json({
      'body.data.type': 'profile',
      'body.data.attributes.email': 'a@b.com',
      'body.data.attributes.first_name': 'Ada',
    })).toEqual({ data: { type: 'profile', attributes: { email: 'a@b.com', first_name: 'Ada' } } });
  });

  it('⛔ CONTROL: with no dotted name the body is byte-for-byte what it was', () => {
    // Insertion order kept, nothing re-sorted: the bodies every other operation sends.
    expect(buildConnectionApiBody({ 'body.z': 1, 'body.a': [1, 2], 'body.m': { x: 'y' } }, headers()))
      .toBe('{"z":1,"a":[1,2],"m":{"x":"y"}}');
  });

  it('keeps an OData annotation as one key (Microsoft Graph)', () => {
    expect(json({ 'body.@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/42' }))
      .toEqual({ '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/42' });
    expect(json({ 'body.members@odata.bind': ['x'], 'body.displayName': 'Team' }))
      .toEqual({ 'members@odata.bind': ['x'], displayName: 'Team' });
    expect(json({ 'body.group.@odata.type': '#microsoft.graph.group' }))
      .toEqual({ group: { '@odata.type': '#microsoft.graph.group' } });
  });

  it('keeps a form body\'s names as they are (Twilio)', () => {
    const h = headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(buildConnectionApiBody({ 'body.Parameter1.Name': 'caller', 'body.Parameter1.Value': '42' }, h))
      .toBe('Parameter1.Name=caller&Parameter1.Value=42');
  });

  it('adds a field to a copy of the object sent for its parent (Asana declares both)', () => {
    const data = { name: 'Launch', workspace: 'w1' };
    expect(json({ 'body.data': data, 'body.data.notes': 'Q4' }))
      .toEqual({ data: { name: 'Launch', workspace: 'w1', notes: 'Q4' } });
    // Either order: the parent is placed first.
    expect(json({ 'body.data.notes': 'Q4', 'body.data': data }))
      .toEqual({ data: { name: 'Launch', workspace: 'w1', notes: 'Q4' } });
    expect(data).toEqual({ name: 'Launch', workspace: 'w1' });
  });

  it('⛔ refuses two fields for the same place instead of choosing', () => {
    const run = (): unknown => buildConnectionApiBody(
      { 'body.data': { name: 'Launch' }, 'body.data.name': 'Other' },
      headers(),
    );
    expect(run).toThrow(IngredientError);
    expect(run).toThrow(/two arguments set the body field 'data\.name'/);
  });

  it('⛔ refuses a field under a parent that is not an object', () => {
    expect(() => buildConnectionApiBody({ 'body.data': 'text', 'body.data.name': 'x' }, headers()))
      .toThrow(/body field 'data' is not an object, so 'data\.name' has nowhere to go/);
    expect(() => buildConnectionApiBody({ 'body.items': [1], 'body.items.first': 'x' }, headers()))
      .toThrow(/body field 'items' is not an object/);
  });

  it('drops a field with a prototype-sensitive segment, as it drops a top-level one', () => {
    const body = buildConnectionApiBody({
      'body.a.__proto__.polluted': 'yes',
      'body.constructor.prototype.x': 1,
      'body.ok.kept': true,
    }, headers());
    expect(JSON.parse(body!)).toEqual({ ok: { kept: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps a name with an empty segment whole, as it always did', () => {
    expect(json({ 'body.a..b': 1, 'body.c.d': 2 })).toEqual({ 'a..b': 1, c: { d: 2 } });
  });

  it('serialises exact decimal integers beside a nested field', () => {
    expect(buildConnectionApiBody({
      'body.owner_id': '9007199254740993',
      'body.meta.note': 'x',
      __rc_json_decimal_integer_fields: '["owner_id"]',
    }, headers())).toBe('{"owner_id":9007199254740993,"meta":{"note":"x"}}');
  });
});
