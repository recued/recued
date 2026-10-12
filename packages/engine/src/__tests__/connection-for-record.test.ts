/** D-320 ruling 20g — `connectionForRecord`: a step the host marked follows the
 *  connection its record's id names (D-190), when the record is of the kind the step
 *  takes; anything else keeps the step's own connection, and a marked step with none
 *  is refused before any call, as the gateway refuses it. */

import { describe, expect, it } from 'vitest';
import { PlatformRecordIdError, type IngredientManifest } from '@recued/contracts';

import { connectionForRecord } from '../step-runner.js';

const manifest = {
  slug: 'hubspot-catalog',
  operations: {
    'deal.read': { record_id_arg: 'deal_id' },
    'engagement.list': { record_id_arg: 'deal_id' },
    'deal.search': {},
  },
} as unknown as IngredientManifest;

const marked = { id: 'deal', connection_follows_record: true };
const read = (deal_id: unknown, operation = 'deal.read') => ({ operation, args: { deal_id } });
const APP_DEAL = 'hubspot_deal_hubspot-app_9001';

describe('D-320 ruling 20g — connectionForRecord', () => {
  it("follows a marked step's record to its connection, whatever op takes that kind", () => {
    expect(connectionForRecord(marked, manifest, read(APP_DEAL), 'hubspot-key')).toBe('hubspot-app');
    // `engagement.list` takes a deal's id: the argument names the kind, not the op.
    expect(connectionForRecord(marked, manifest, read(APP_DEAL, 'engagement.list'), 'hubspot-key')).toBe('hubspot-app');
    // A run that left the step to its records gave it none.
    expect(connectionForRecord(marked, manifest, read(APP_DEAL), '')).toBe('hubspot-app');
  });

  it.each([
    ['an unmarked step (its connection was chosen)', { id: 'deal' }, read(APP_DEAL)],
    ['an id that names no connection', marked, read('9001')],
    ['a record of another kind (a contact on a deal read)', marked, read('hubspot_contact_hubspot-app_9001')],
    ['an op with no record argument', marked, { operation: 'deal.search', args: { deal_id: APP_DEAL } }],
  ])('keeps the step\'s own connection for %s', (_why, step, input) => {
    expect(connectionForRecord(step, manifest, input, 'hubspot-key')).toBe('hubspot-key');
  });

  it('refuses a marked step with no connection of its own, before any call', () => {
    const refused = (input: Record<string, unknown>) => {
      try {
        connectionForRecord(marked, manifest, input, '');
      } catch (e) {
        return e;
      }
      return undefined;
    };
    expect(refused(read('9001'))).toBeInstanceOf(PlatformRecordIdError);
    expect(refused(read('9001'))).toMatchObject({ code: 'PLATFORM_ID_CONNECTION_REQUIRED' });
    expect((refused(read('9001')) as Error).message).toContain("Pass the record's target_id");
    // A record of another kind: the gateway's own refusal, word for word.
    expect(refused(read('hubspot_contact_hubspot-app_9001'))).toMatchObject({
      code: 'PLATFORM_ID_KIND_MISMATCH',
      message: "PLATFORM_ID_KIND_MISMATCH: 'deal.read' takes a deal's id in 'deal_id', and the id given is a "
        + "contact's. No provider call was made. Pass the deal's own id.",
    });
  });
});
