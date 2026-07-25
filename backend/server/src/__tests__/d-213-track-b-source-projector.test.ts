import { describe, expect, it, vi } from 'vitest';
import type { PiiAliasableData } from '@recued/contracts';
import type { EntityPromptPart } from '@recued/middleware';
import { piiEgress } from '@recued/gateway';

import {
  createRetainablePromptPartValidator,
  MAX_ENTITY_PARTS,
  projectEntityPromptPartCandidates,
  projectToolDispatchCandidates,
  validateRetainablePromptPart,
} from '../chat-pii-source.js';

const resolver: piiEgress.FieldPrivacyResolver = (packet) => {
  const value = packet as unknown;
  if (Array.isArray(value)) {
    return [
      { path: '0.email', kind: 'email' },
      { path: '0.name', kind: 'name' },
      { path: '0.company', kind: 'org' },
    ];
  }
  return [
    { path: 'prior_tool_calls.0.result.owner', kind: 'email' },
    { path: 'prior_tool_calls.0.result.note', kind: 'content' },
    { path: 'recall_context.0.result.owner', kind: 'email' },
  ];
};

describe('D-213 Track B — flat source projector', () => {
  it('retains only exact typed values and never invokes render', () => {
    const render = vi.fn(() => 'must not execute');
    const part: EntityPromptPart = {
      source: 'prompt-cache',
      role: 'entity',
      entity: 'contact',
      payload: [{
        email: 'Alice@Acme.com',
        name: 'ALICE ADA',
        company: 'Acme Corp',
        kind: 'contact',
      }],
      render,
    };

    expect(projectEntityPromptPartCandidates([part], resolver)).toEqual([
      { value: 'Alice@Acme.com', kind: 'email' },
      { value: 'ALICE ADA', kind: 'name' },
      { value: 'Acme Corp', kind: 'org' },
    ]);
    expect(render).not.toHaveBeenCalled();
    expect(
      Object.keys(projectEntityPromptPartCandidates([part], resolver)[0]!),
    ).toEqual(['value', 'kind']);
  });

  it('rejects a reserved core id carrying a non-core shape at contribution', () => {
    expect(() => validateRetainablePromptPart({
      source: 'pack',
      role: 'entity',
      entity: 'contact',
      payload: [{ ssn: '123-45-6789' }],
      render: () => '',
    })).toThrow('reserved contact entity used with a non-core shape');
    expect(() => validateRetainablePromptPart({
      source: 'pack',
      role: 'entity',
      entity: 'contact',
      payload: [{ email: { credential: 'not-an-email-field' } }],
      render: () => '',
    })).toThrow('reserved contact entity used with a non-core shape');
  });

  it('enforces source limits cumulatively at the contribution boundary', () => {
    const validate = createRetainablePromptPartValidator();
    for (let index = 0; index < MAX_ENTITY_PARTS; index += 1) {
      validate({
        source: `producer-${index}`,
        role: 'entity',
        entity: 'contact',
        payload: [{ email: `person-${index}@example.com` }],
        render: () => '',
      });
    }
    expect(() => validate({
      source: 'one-too-many',
      role: 'entity',
      entity: 'contact',
      payload: [],
      render: () => '',
    })).toThrow('entity part limit exceeded');

    const validateBytes = createRetainablePromptPartValidator();
    validateBytes({
      source: 'large-a',
      role: 'entity',
      entity: 'contact',
      payload: [{ name: 'a'.repeat(600_000) }],
      render: () => '',
    });
    expect(() => validateBytes({
      source: 'large-b',
      role: 'entity',
      entity: 'contact',
      payload: [{ name: 'b'.repeat(600_000) }],
      render: () => '',
    })).toThrow('entity payload exceeds source bounds');

    expect(() => validateRetainablePromptPart({
      source: 'oversized-key',
      role: 'entity',
      entity: 'vendor.crm/lead',
      payload: [{
        ['k'.repeat(1_048_577)]: 'small value',
      }],
      render: () => '',
    })).toThrow('entity payload exceeds source bounds');

    expect(() => validateRetainablePromptPart({
      source: 'non-finite-number',
      role: 'entity',
      entity: 'vendor.crm/lead',
      payload: [{ confidence: Number.POSITIVE_INFINITY }],
      render: () => '',
    })).toThrow('entity payload is not JSON data');
  });

  it('requires non-core ids to be namespaced', () => {
    expect(() => validateRetainablePromptPart({
      source: 'pack',
      role: 'entity',
      entity: 'lead',
      payload: [{ email: 'lead@example.com' }],
      render: () => '',
    })).toThrow('non-core entity id must be namespaced');
    expect(() => validateRetainablePromptPart({
      source: 'pack',
      role: 'entity',
      entity: 'vendor.crm/lead',
      payload: [{ email: 'lead@example.com' }],
      render: () => '',
    })).not.toThrow();
  });

  it('projects tool candidates but not recall broker content or free-form output', () => {
    const packet = {
      prior_tool_calls: [{
        result: {
          owner: 'owner@acme.com',
          note: 'entire tool output must not be retained',
        },
      }],
      recall_context: [{
        result: { owner: 'recalled@acme.com' },
      }],
    } as PiiAliasableData;
    expect(projectToolDispatchCandidates(packet, resolver)).toEqual([
      { value: 'owner@acme.com', kind: 'email' },
    ]);
  });

  it('retains the postcode leaf and derives its D-167 composite forms, while coarse location stays out', () => {
    // The POSTCODE IS RETAINED — it is not coarse. D-167 aliases it at its leaf
    // and needs it to derive the composite prose forms below. Coarse is
    // city/state/country only, and those stay VISIBLE (open-question #9).
    const packet = {
      prior_tool_calls: [{
        result: {
          mailing_address: {
            address1: '1 Main Street',
            city: 'Mountain View',
            state: 'CA',
            zip: '94043',
            country: 'USA',
          },
        },
      }],
    } as PiiAliasableData;
    const projected = projectToolDispatchCandidates(packet, () => [{
      path: 'prior_tool_calls.0.result.mailing_address',
      kind: 'address',
    }]);
    const values = projected.map((candidate) => candidate.value);
    expect(projected.every((candidate) => candidate.kind === 'address')).toBe(true);
    // Leaves: the precise identifiers, postcode included.
    expect(values).toContain('1 Main Street');
    expect(values).toContain('94043');
    // Composites: the layouts that give the postcode its NEIGHBOURS, so a
    // reharvested address matches the whole run in prose exactly as a live one
    // does. Without these the run leaks and the bare postcode is all that is left.
    expect(values).toContain('Mountain View, CA 94043');
    expect(values).toContain('Mountain View CA 94043');
    expect(values).toContain('Mountain View 94043');
    // Coarse leaves never stand alone as candidates.
    expect(values).not.toContain('Mountain View');
    expect(values).not.toContain('CA');
    expect(values).not.toContain('USA');
    // Every composite is derived from D-167's own generator, never restated here.
    for (const form of piiEgress.addressMatchForms({
      city: 'Mountain View', state: 'CA', postal: '94043',
    })) {
      expect(values).toContain(form);
    }
  });

  it('derives its coarse-address set from D-167 rather than restating it', () => {
    // A hand-copied vocabulary rots: this set once diverged into calling the
    // postcode coarse, which would have removed protection rather than added it.
    expect(piiEgress.ADDRESS_COARSE_KEYS.has('city')).toBe(true);
    expect(piiEgress.ADDRESS_COARSE_KEYS.has('state')).toBe(true);
    expect(piiEgress.ADDRESS_COARSE_KEYS.has('country')).toBe(true);
    for (const postal of ['zip', 'postcode', 'postal_code', 'zip_code']) {
      expect(piiEgress.ADDRESS_COARSE_KEYS.has(postal)).toBe(false);
    }
  });

  it('excludes every descendant of a coarse address field', () => {
    const packet = {
      prior_tool_calls: [{
        result: {
          mailing_address: {
            street: { lines: ['1 Main Street', 'Suite 4'] },
            city: { labels: ['San Francisco'] },
            region: ['California'],
            country: { name: 'United States' },
          },
        },
      }],
    } as PiiAliasableData;
    const projected = projectToolDispatchCandidates(packet, () => [{
      path: 'prior_tool_calls.0.result.mailing_address',
      kind: 'address',
    }]);
    expect(projected).toEqual([
      { value: 'Suite 4', kind: 'address' },
      { value: '1 Main Street', kind: 'address' },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(
      /San Francisco|California|United States/u,
    );
  });

  it('does not propagate a non-address tag through an object container', () => {
    const packet = {
      prior_tool_calls: [{
        result: {
          owner: {
            name: 'Alice Ada',
            email: 'alice@example.com',
          },
        },
      }],
    } as PiiAliasableData;
    expect(projectToolDispatchCandidates(packet, () => [{
      path: 'prior_tool_calls.0.result.owner',
      kind: 'name',
    }])).toEqual([]);
  });

  it('retains direct scalar arrays without interpreting nested records', () => {
    const packet = {
      prior_tool_calls: [{
        result: {
          emails: [
            'alice@example.com',
            { hidden: 'must-not-project@example.com' },
          ],
        },
      }],
    } as PiiAliasableData;
    expect(projectToolDispatchCandidates(packet, () => [{
      path: 'prior_tool_calls.0.result.emails',
      kind: 'email',
    }])).toEqual([
      { value: 'alice@example.com', kind: 'email' },
    ]);
  });
});
