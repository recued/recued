import { describe, expect, it } from 'vitest';

import {
  BATCHING_HINT_EXAMPLE,
  FRAMING_BLOCK,
  NOTATION_BLOCK,
  PROTOCOL_BLOCK,
  renderSectionBlock,
  renderSystemPrompt,
  renderToolRow,
} from '../templates/render';
import type { CatalogToolEntry, SectionAssembly, SectionedCatalog } from '../types';

const tool = (
  overrides: Pick<CatalogToolEntry, 'name' | 'description'> & Partial<CatalogToolEntry>,
): CatalogToolEntry => ({
  concurrency_safe: true,
  ...overrides,
});

const section = (
  sectionName: SectionAssembly['section'],
  overrides: Partial<Omit<SectionAssembly, 'section'>> = {},
): SectionAssembly => ({
  section: sectionName,
  description: `${sectionName} tools`,
  tools: [],
  ...overrides,
});

const catalog = (sections: ReadonlyArray<SectionAssembly>): SectionedCatalog => ({
  sections,
});

describe('D-164 P4a renderToolRow', () => {
  it('renders only the row head when return_shape is absent', () => {
    expect(renderToolRow(tool({
      name: 'contact.search',
      description: 'Find matching contacts',
    }))).toBe('- contact.search \u2014 Find matching contacts');
  });

  it('renders the Returns continuation with exactly four spaces when return_shape is present', () => {
    expect(renderToolRow(tool({
      name: 'commitment.followthrough.score',
      description: 'Score follow-through risk',
      return_shape: '{ contact: REF<contacts>, score: number }',
    }))).toBe(
      '- commitment.followthrough.score \u2014 Score follow-through risk\n'
      + '    Returns: { contact: REF<contacts>, score: number }',
    );
  });
});

describe('D-164 P4a renderSectionBlock', () => {
  it('returns an empty string for sections with zero tools', () => {
    expect(renderSectionBlock(section('recipes'))).toBe('');
  });

  it('renders non-empty sections as description, one blank line, then tool rows', () => {
    expect(renderSectionBlock(section('enrichment', {
      description: 'Run trusted enrichment topics.',
      tools: [
        tool({
          name: 'source.freshness.degradation',
          description: 'Assess source freshness',
          return_shape: '{ source: REF<files>, stale: boolean }',
        }),
        tool({
          name: 'standing.instruction.conflict',
          description: 'Find instruction conflicts',
          return_shape: '{ instructions: [REF<memory>], conflict: boolean }',
        }),
      ],
    }))).toBe(
      'Run trusted enrichment topics.\n\n'
      + '- source.freshness.degradation \u2014 Assess source freshness\n'
      + '    Returns: { source: REF<files>, stale: boolean }\n'
      + '- standing.instruction.conflict \u2014 Find instruction conflicts\n'
      + '    Returns: { instructions: [REF<memory>], conflict: boolean }',
    );
  });

  it('inserts the batching example only for the entity-query section', () => {
    const tools = [
      tool({
        name: 'contact.search',
        description: 'Search contacts',
      }),
    ];

    const enrichment = renderSectionBlock(section('enrichment', {
      description: 'Resolve enrichment facts.',
      tools,
    }));
    const entityQuery = renderSectionBlock(section('entity-query', {
      description: 'Resolve entity references.',
      tools,
    }));

    expect(enrichment).not.toContain(BATCHING_HINT_EXAMPLE);
    expect(entityQuery).toContain(BATCHING_HINT_EXAMPLE);
    expect(entityQuery).toBe(
      'Resolve entity references.\n\n'
      + `${BATCHING_HINT_EXAMPLE}\n\n`
      + '- contact.search \u2014 Search contacts',
    );
  });
});

describe('D-164 P4a renderSystemPrompt', () => {
  it('joins non-empty blocks with double-newlines and skips empty sections', () => {
    const enrichmentBlock =
      'Run enrichment topics.\n\n'
      + '- commitment.followthrough.score \u2014 Score commitments\n'
      + '    Returns: { score: number }';
    const memoryBlock = 'Search saved memory.\n\n- memory.search \u2014 Search memory notes';

    const prompt = renderSystemPrompt(catalog([
      section('enrichment', {
        description: 'Run enrichment topics.',
        tools: [
          tool({
            name: 'commitment.followthrough.score',
            description: 'Score commitments',
            return_shape: '{ score: number }',
          }),
        ],
      }),
      section('entity-query'),
      section('memory-recall', {
        description: 'Search saved memory.',
        tools: [
          tool({
            name: 'memory.search',
            description: 'Search memory notes',
          }),
        ],
      }),
      section('entity-action'),
      section('recipes'),
      section('other'),
    ]));

    expect(prompt).toBe([
      FRAMING_BLOCK,
      enrichmentBlock,
      memoryBlock,
      NOTATION_BLOCK,
      PROTOCOL_BLOCK,
    ].join('\n\n'));
    expect(prompt).not.toContain('\n\n\n');
  });

  it('renders framing, notation, and protocol exactly when all sections are empty', () => {
    expect(renderSystemPrompt(catalog([
      section('enrichment'),
      section('entity-query'),
      section('memory-recall'),
      section('entity-action'),
      section('recipes'),
      section('other'),
    ]))).toBe([
      FRAMING_BLOCK,
      NOTATION_BLOCK,
      PROTOCOL_BLOCK,
    ].join('\n\n'));
  });
});

describe('D-164 P4a prompt block verbatim ports', () => {
  it('keeps the bench phrases in the exported prompt constants', () => {
    const normalizedFraming = FRAMING_BLOCK.replace(/\s+/g, ' ');

    expect(normalizedFraming).toContain('personal-data warehouse');
    expect(normalizedFraming).toContain('six surfaces');

    expect(BATCHING_HINT_EXAMPLE).toContain('alice@x.com');
    expect(BATCHING_HINT_EXAMPLE).toContain('bob@x.com');
    expect(BATCHING_HINT_EXAMPLE).toContain('carol@x.com');

    expect(NOTATION_BLOCK).toContain('REF<X>');
    expect(NOTATION_BLOCK).toContain('TypeScript-ish notation');

    expect(PROTOCOL_BLOCK).toContain('exactly ONE JSON object');
  });
});
