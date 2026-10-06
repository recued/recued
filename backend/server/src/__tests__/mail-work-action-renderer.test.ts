import { describe, expect, it } from 'vitest';
import { renderMailWorkAction } from '../mail-work-action-renderer.js';

const known = new Set(['mail_source_1']);
const notes = 'Lena may be asked about the timetable. Contact anyone else only after my approval. Private writing is allowed.';
const action = () => ({ mode: 'contact', scope: 'timetable', permission: 'requires_owner_approval', permission_quote: null, conditions: [] });

describe('scoped work action presentation', () => {
  it('renders required approval on the contact action itself', () => {
    expect(renderMailWorkAction(action(), 'Ask the coordinator about availability.', notes, known).text)
      .toBe('After your approval: Ask the coordinator about availability.');
  });
  it.each(['Lena may be asked about the timetable.', 'Contact anyone else only after my approval.'])(
    'does not certify permission from an exact source quotation: %s', quote => {
      expect(() => renderMailWorkAction({ ...action(), permission: 'explicitly_permitted', permission_quote: quote },
        'Ask Lena about the timetable.', notes, known)).toThrow();
    });
  it('renders private preparation without contact approval', () => {
    expect(renderMailWorkAction({ ...action(), mode: 'private_preparation', permission: 'not_contact' },
      'Draft options privately.', notes, known).text).toBe('Private preparation: Draft options privately.');
  });
  it('keeps an evidenced condition scoped and retains its citation', () => {
    expect(renderMailWorkAction({ ...action(), conditions: [{ scope: 'timetable', text: 'The captioning team must be available.', sources: ['mail_source_1'], owner_quote: null }] },
      'Ask the coordinator about availability.', notes, known)).toMatchObject({ sources: ['mail_source_1'], text: expect.stringContaining('Conditions for timetable:') });
  });
  it('distinguishes an inferred possible prerequisite from an established condition', () => {
    expect(renderMailWorkAction({ ...action(), conditions: [{ scope: 'timetable', text: 'A venue may be needed.', sources: [], owner_quote: null }] },
      'Ask about the timetable.', notes, known)).toMatchObject({ sources: [],
      text: expect.stringContaining('Possible prerequisites for timetable (AI inference, not established):') });
  });
  it('can wait for contact approval without treating waiting as contact', () => {
    expect(renderMailWorkAction({ ...action(), mode: 'wait' }, 'Wait before contacting the client.', notes, known).text)
      .toBe('Waiting for your approval: Wait before contacting the client.');
  });
  it.each([
    { mode: ['contact'], permission: 'not_contact' },
    { permission: 'not_contact' },
    { permission: 'explicitly_permitted', permission_quote: 'Lena may buy equipment.' },
    { mode: 'private_preparation', permission: 'requires_owner_approval' },
    { conditions: [{ scope: 'physical installation', text: 'Building access.', sources: ['mail_source_1'], owner_quote: null }] },
    { conditions: [{ scope: 'timetable', text: 'Building access.', sources: ['mail_source_999'], owner_quote: null }] },
  ])('rejects incomplete or contradictory declared permission/scope: %j', fields => {
    expect(() => renderMailWorkAction({ ...action(), ...fields }, 'Prepare the next step.', notes, known)).toThrow();
  });
});
