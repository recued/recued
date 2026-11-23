import { describe, expect, it, vi } from 'vitest';
import { createMailFind } from '../mail-find.js';

const setup = () => {
  const reader = { contains: () => true, querySelector: () => null, querySelectorAll: () => [] };
  const root = { querySelector: () => reader } as unknown as HTMLElement;
  const searchEverywhere = vi.fn(), render = vi.fn();
  const finder = createMailFind({ document: {} as Document, root, actionAttr: 'data-act', render, onSearchEverywhere: searchEverywhere });
  const button = { focus() {} } as HTMLElement;
  const show = () => finder.handleAction('mail-message-find-open', button);
  const query = (value: string) => finder.handleInput({ value, hasAttribute: () => true } as unknown as HTMLElement);
  return { finder, show, query, button, searchEverywhere };
};

describe('Mail reader find', () => {
  it('restores a detoured email query and active match only to the same reader identity', () => {
    const { finder, show, query, button } = setup();
    finder.setMessage('work/mail-1/v1', 'needle one needle two'); show(); query('needle');
    finder.handleAction('mail-message-find-next', button); const saved = finder.snapshot();
    finder.reset(); finder.setMessage('home/mail-1/v1', 'needle elsewhere');
    expect(finder.restore(saved)).toBe(false); expect(finder.renderBar()).toBe('');
    finder.reset(); finder.setMessage('work/mail-1/v1', 'needle one needle two');
    expect(finder.restore(saved)).toBe(true); expect(finder.renderBar()).toContain('2 of 2 matches.');
    finder.reset(); finder.setMessage('work/mail-1/v1', 'needle changed');
    finder.restore(saved); expect(finder.renderBar()).toContain('1 of 1 matches.');
  });
  it('highlights literal original text and escapes email markup and query attributes', () => {
    const { finder, show, query, button } = setup();
    const body = '\n  Café 😀 [a.*] and CAFÉ 😀 [A.*]\n<img src=x onerror=alert(1)>  \n';
    finder.setMessage('work/mail-1/v1', body); const plain = finder.renderBody(); show(); query('[a.*]');
    expect(finder.renderBar()).toContain('1 of 2 matches.');
    expect(finder.renderBody()).toContain('>[a.*]</mark>'); expect(finder.renderBody()).toContain('>[A.*]</mark>');
    expect(finder.renderBody()).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(finder.renderBody()).not.toContain('<img');
    query('café'); expect(finder.renderBody()).toContain('>Café</mark>'); expect(finder.renderBody()).toContain('>CAFÉ</mark>');
    query('😀'); expect(finder.renderBar()).toContain('1 of 2 matches.'); expect(finder.renderBody().match(/>😀<\/mark>/gu)).toHaveLength(2);
    query('" autofocus onfocus="unsafe'); expect(finder.renderBar()).toContain('&quot; autofocus onfocus=&quot;unsafe');
    finder.handleAction('mail-message-find-close', button); expect(finder.renderBody()).toBe(plain);
  });

  it('preserves the same email query through refreshed text, clamps the match and isolates another mailbox or enrollment', () => {
    const { finder, show, query, button, searchEverywhere } = setup();
    finder.setMessage('work/mail-1/v1', 'needle one needle two'); show(); query('needle');
    finder.handleAction('mail-message-find-next', button); expect(finder.renderBar()).toContain('2 of 2 matches.');
    finder.setMessage('work/mail-1/v1', 'needle refreshed'); expect(finder.renderBar()).toContain('1 of 1 matches.');
    finder.handleAction('mail-message-find-everywhere', button); expect(searchEverywhere).toHaveBeenCalledWith('needle');
    finder.setMessage('personal/mail-1/v1', 'needle elsewhere'); expect(finder.renderBar()).toBe(''); show();
    expect(finder.renderBar()).toContain('value=""'); expect(finder.renderBody()).not.toContain('<mark');
    query('elsewhere'); finder.setMessage('personal/mail-1/v2', 'needle replaced'); expect(finder.renderBar()).toBe('');
  });

  it('bounds highlights and reports only the displayed text, including empty and unavailable bodies', () => {
    const { finder, show, query } = setup();
    finder.setMessage('work/mail-1/v1', 'needle '.repeat(1001), true); show(); query('needle');
    expect(finder.renderBar()).toContain('1 of 1,000+ matches. Narrow your search to see more.');
    expect(finder.renderBody().match(/<mark /g)).toHaveLength(1000);
    expect(finder.renderBar()).toContain('Only the displayed part of this email is searched.');
    query('absent'); expect(finder.renderBar()).toContain('No matches in the displayed text.');
    finder.setMessage('work/mail-1/v1', null); expect(finder.renderBar()).toContain('Email text is unavailable.');
    finder.setMessage('work/mail-1/v1', '', true); expect(finder.renderBar()).toContain('No text in the displayed part of this email.');
    finder.setMessage('work/mail-1/v1', ''); query('Empty message'); expect(finder.renderBar()).toContain('This email is empty.');
    expect(finder.renderBody()).toBe('(Empty message)'); expect(finder.renderTrigger()).toContain(' disabled');
  });
});
