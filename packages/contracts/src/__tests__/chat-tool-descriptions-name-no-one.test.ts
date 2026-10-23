import { describe, expect, it } from 'vitest';

import { TIER1_TOOL_DESCRIPTORS } from '../chat.js';

/** Every string a model reads in the Tier-1 descriptors — tool descriptions and
 *  argument descriptions, at any depth — with the path it sits at. */
const strings = (value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> => {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${path}[${index}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) strings(item, `${path}.${key}`, out);
  }
  return out;
};

// "Mary" is the code's name for the owner, and these descriptions used it: every
// owner's agent, and every directory that lists Recued's tools, read "Search
// Mary's mail mirror". The data is the owner's; the person the agent is talking
// to is the user (internal design notes, 2026-10-22).
describe('the Tier-1 tool descriptions name no one', () => {
  const all = strings(TIER1_TOOL_DESCRIPTORS, 'TIER1_TOOL_DESCRIPTORS');

  it('reads the descriptions it checks', () => {
    expect(all.filter(([path]) => path.endsWith('.description')).length).toBeGreaterThan(20);
  });

  it('never names Mary', () => {
    expect(all.filter(([, text]) => /\bMary\b/.test(text)).map(([path]) => path)).toEqual([]);
  });

  it('never calls the owner or the user she or her', () => {
    expect(all.filter(([, text]) => /\b(she|her|hers|herself)\b/i.test(text)).map(([path]) => path)).toEqual([]);
  });
});
