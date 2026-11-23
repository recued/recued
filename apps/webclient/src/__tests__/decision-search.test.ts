import { describe, expect, it } from 'vitest';
import { decisionSearchTerms, decisionSearchText, decisionTextMatches } from '../approvals/decision-search.js';

const element = (tagName: string, textContent = '', children: HTMLElement[] = [], attrs: Record<string, string> = {}) =>
  ({ tagName, textContent, children, hidden: false, getAttribute: (name: string) => attrs[name] ?? null }) as unknown as HTMLElement;
const matches = (card: HTMLElement, query: string) => decisionTextMatches(decisionSearchText(card), decisionSearchTerms(query));

describe('approval search uses the rendered review', () => {
  it('matches literal terms across request text and metadata, with Unicode normalization', () => {
    const card = element('ARTICLE', '', [element('H3', 'Send Cafe\u0301 ﬁle'), element('P', 'Recipe: North mail'), element('PRE', '<img.*>')]);
    expect(matches(card, 'CAFÉ FILE north')).toBe(true);
    expect(matches(card, '<img.*>')).toBe(true);
    expect(matches(card, 'unrelated north')).toBe(false);
    expect(matches(card, '   ')).toBe(true);
  });

  it('excludes written answers, secrets, action labels and transient errors', () => {
    const card = element('ARTICLE', '', [element('P', 'Review the quote'),
      element('TEXTAREA', 'private reason'), element('INPUT', 'private code'), element('BUTTON', 'Approve'),
      element('DIV', 'Temporary transport failure', [], { role: 'alert' }), element('DIV', 'Resolving request', [], { role: 'status' })]);
    expect(matches(card, 'quote')).toBe(true);
    for (const query of ['private reason', 'private code', 'Approve', 'transport failure', 'Resolving']) expect(matches(card, query)).toBe(false);
  });

  it('can reveal a filtered root again without searching content hidden by the card renderer', () => {
    const hidden = element('P', 'unavailable payload'); hidden.hidden = true;
    const card = element('ARTICLE', '', [element('H3', 'Review mail'), hidden,
      element('SPAN', 'decorative wording', [], { 'aria-hidden': 'true' })]); card.hidden = true;
    expect(matches(card, 'mail')).toBe(true);
    expect(matches(card, 'payload')).toBe(false);
    expect(matches(card, 'decorative')).toBe(false);
  });

  it('searches readable disclosure content without depending on whether it is expanded', () => {
    const card = element('ARTICLE', '', [element('DETAILS', '', [element('SUMMARY', 'Read the quote'), element('PRE', 'Total: $1,250')])]);
    expect(matches(card, '$1,250')).toBe(true);
  });
});
