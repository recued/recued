export type DecisionKind = 'gate' | 'ask' | 'plan';
export type DecisionFilter = 'all' | DecisionKind;

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ').replace(/\s+/gu, ' ');
export const decisionSearchTerms = (query: string): string[] => normalize(query).trim().split(' ').filter(Boolean);
export const decisionTextMatches = (text: string, terms: readonly string[]): boolean => terms.every(term => text.includes(term));

/** Index the review the card actually renders, including readable disclosures.
 * Raw model fields can contain metadata or unavailable payloads the card omits.
 * Typed answers, secrets, action buttons and transient errors are not evidence
 * about the request and must never make a card match. Ignore only the root's
 * hidden flag, which belongs to this filter rather than the card renderer. */
export const decisionReviewText = (card: HTMLElement): string => {
  const read = (element: HTMLElement, root = false): string => {
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SCRIPT', 'STYLE'].includes(element.tagName)
      || !root && (element.hidden || element.getAttribute('aria-hidden') === 'true')
      || ['alert', 'status'].includes(element.getAttribute('role') ?? '')) return '';
    const nodes = Array.from(element.childNodes ?? element.children);
    if (!nodes.length) return element.textContent ?? '';
    return nodes.map(node => 'tagName' in node ? read(node as HTMLElement)
      : node.nodeType === 3 ? node.textContent ?? '' : '').join(' ');
  };
  return read(card, true).replace(/\s+/gu, ' ').trim();
};
export const decisionSearchText = (card: HTMLElement): string => normalize(decisionReviewText(card));
