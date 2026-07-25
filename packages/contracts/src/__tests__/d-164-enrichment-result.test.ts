import { describe, expect, it } from 'vitest';

import type { EnrichmentResult, EntityRef, SuggestDirective } from '@recued/contracts';

type ProducerPayload = { contact: string; count: number };

describe('D-164 enrichment result — type semantics', () => {
  it('narrows found and not-found branches', () => {
    const result: EnrichmentResult<ProducerPayload> =
      { found: true, contact: 'ada@example.com', count: 2 };
    if (result.found) {
      const contact: string = result.contact; const count: number = result.count;
      expect([contact, count]).toEqual(['ada@example.com', 2]);
    }
    const missing: EnrichmentResult<ProducerPayload> =
      { found: false, suggest: { tool: 'entity.query', kind: 'contact', hint: 'Search contacts.' } };
    if (!missing.found) {
      const tool: string = missing.suggest.tool;
      expect(tool).toBe('entity.query');
    }
  });
  it('rejects producer payloads that declare found', () => {
    // @ts-expect-error — producer payloads must not declare their own found key.
    type BadResult = EnrichmentResult<{ found: 'maybe' }>;
    void (undefined as unknown as BadResult);
  });
  it('keeps EntityRef fields readonly strings', () => {
    const assertRef = (ref: EntityRef) => {
      const entity: string = ref.entity; const name: string = ref.name;
      // @ts-expect-error — EntityRef.entity is readonly.
      ref.entity = 'contact:other';
      // @ts-expect-error — EntityRef.name is readonly.
      ref.name = 'Other';
      void [entity, name];
    };
    void assertRef;
  });
  it('accepts an array-shaped payload', () => {
    type Item = { id: string };
    const arrResult: EnrichmentResult<readonly Item[]> = {
      found: true,
      0: { id: 'a' },
      1: { id: 'b' },
      length: 2,
    } as unknown as EnrichmentResult<readonly Item[]>;
    if (arrResult.found) {
      expect(arrResult.length).toBe(2);
      expect(arrResult[0]).toEqual({ id: 'a' });
    }
  });

  it('keeps SuggestDirective args optional and readonly-indexed when present', () => {
    const withoutArgs: SuggestDirective = { tool: 'entity.query', kind: 'contact', hint: 'Search contacts.' };
    const withArgs: SuggestDirective = { ...withoutArgs, args: { email: 'ada@example.com' } };
    expect(withoutArgs.args).toBeUndefined();
    if (withArgs.args) {
      const args: Readonly<Record<string, unknown>> = withArgs.args;
      expect(args.email).toBe('ada@example.com');
    }
  });
});
