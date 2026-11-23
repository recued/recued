/** "Active passes" says what a pass lets through by name ("Send mail"), where it printed the ids. */
import { describe, expect, it } from 'vitest';

import { passActionNames } from '../kind-session-grant.js';

describe('the actions a pass lets through, by name', () => {
  it('uses the server\'s names for the operations, else the ingredients', () => {
    expect(passActionNames({ grant_mode: 'exact', permits: { operation_ids: ['send-email'] }, permit_names: ['Send mail'] }))
      .toEqual(['Send mail']);
    expect(passActionNames({ grant_mode: 'batch', permits: { ingredient_ids: ['deal-reader-hubspot'] }, permit_names: ['Read a deal'] }))
      .toEqual(['Read a deal']);
  });

  it('keeps the ids from an older server, or names that do not line up', () => {
    expect(passActionNames({ grant_mode: 'exact', permits: { operation_ids: ['send-email'] } })).toEqual(['send-email']);
    expect(passActionNames({ grant_mode: 'exact', permits: { operation_ids: ['a', 'b'] }, permit_names: ['A'] })).toEqual(['a', 'b']);
    expect(passActionNames({ grant_mode: 'exact', permits: { operation_ids: ['a'] }, permit_names: [' '] })).toEqual(['a']);
  });

  it('names nothing for a kind pass, whose title already says it', () => {
    expect(passActionNames({ grant_mode: 'kind', permits: { operation_ids: ['work.create:task'] }, permit_names: ['Add a task'] }))
      .toEqual([]);
  });
});
