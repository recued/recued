/** Literal template patterns must not lose mail to the regex watchdog, while
 *  patterns with regex syntax still run under its deadline. */

import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { getMailFactBuiltinType, type MailTemplateDefinition } from '@recued/contracts';

import { runRulesPass, type MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import {
  runTemplatePattern,
  TEMPLATE_PATTERN_MAX_INPUT,
  TemplatePatternTimeout,
} from '../mail-facts/template-pattern.js';

/** A loaded or suspended process can exhaust the VM's wall-clock deadline
 *  even for a literal separator. Inject the same native error deterministically. */
const deadline = (): never => {
  throw Object.assign(new Error('Script execution timed out'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
};

describe('literal template patterns', () => {
  it('keeps a repeated return fact when the VM deadline would expire', () => {
    const template: MailTemplateDefinition = {
      name: 'Returns', type: 'return_refund',
      entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'shop.example' }], variables: ['merchant'] },
      rules: Object.entries({ merchant: 'Merchant', return_id: 'Return', order_id: 'Order' }).map(([variable, label]) => ({
        target: { variable }, source: 'body', find: { kind: 'after_label', label: `${label}:` },
      })),
      repeat: { source: 'body', split: '--' }, html: false, ai: { enabled: false },
    };
    const email: MailFactSourceEmail = {
      subject: 'About your order', body_text: '--\nMerchant: Shop\nOrder: O-1\nReturn: R-1b\n',
      html: null, from_address: 'returns@shop.example', from_name: 'Shop',
      headers: {}, labels: ['INBOX'], relationships: [], attachments: [],
    };
    const watchdog = vi.spyOn(Script.prototype, 'runInContext').mockImplementation(deadline);
    try {
      const outcome = runRulesPass(template, getMailFactBuiltinType('return_refund')!, email);
      expect(outcome).toEqual({ kind: 'facts', facts: [expect.objectContaining({
        variables: expect.objectContaining({ merchant: 'Shop', order_id: 'O-1', return_id: 'R-1b' }),
      })] });
    } finally {
      watchdog.mockRestore();
    }
  });

  it('preserves Unicode case matching, flags and match metadata', () => {
    const watchdog = vi.spyOn(Script.prototype, 'runInContext').mockImplementation(deadline);
    try {
      const text = 'prefix\norder K -- suffix';
      const match = runTemplatePattern('ORDER k --', 'imsu', text);
      expect(match?.[0]).toBe('order K --');
      expect(match?.index).toBe(7);
      expect(match?.input).toBe(text);
      expect(runTemplatePattern('order', '', 'ORDER')).toBeNull();
      expect(runTemplatePattern('--', 'gy', '-- --')?.index).toBe(0);
      expect(runTemplatePattern('--', 'gy', '-- --')?.index).toBe(0);
    } finally {
      watchdog.mockRestore();
    }
  });

  it('preserves canonicalized literals and captures on the guarded path', () => {
    expect(runTemplatePattern('ＯＲＤＥＲ K --', 'iu', 'order k --')?.[0]).toBe('order k --');
    expect(runTemplatePattern('（(\\d+)）', '', '(123)')?.[1]).toBe('123');
    expect(runTemplatePattern('a．b', '', 'axb')).toBeNull();
    expect(runTemplatePattern('a．b', '', 'a.b')?.[0]).toBe('a.b');
  });

  it('keeps the input cap for direct literal matches', () => {
    const watchdog = vi.spyOn(Script.prototype, 'runInContext').mockImplementation(deadline);
    try {
      const prefix = 'x'.repeat(TEMPLATE_PATTERN_MAX_INPUT - 2);
      expect(runTemplatePattern('--', '', `${prefix}-- tail`)?.index).toBe(prefix.length);
      expect(runTemplatePattern('--', '', `${prefix}x--`)).toBeNull();
    } finally {
      watchdog.mockRestore();
    }
  });
});

describe('patterns that still need the watchdog', () => {
  it.each(['.', '^a', 'a$', 'a*', 'a+', 'a?', '(a)', '[a]', 'a{2}', 'a|b', '\\d', '（a）＋', '［a］＊'])(
    'keeps the deadline for %s after canonicalization', (pattern) => {
      const watchdog = vi.spyOn(Script.prototype, 'runInContext').mockImplementation(deadline);
      try {
        expect(() => runTemplatePattern(pattern, 'i', 'aaa')).toThrow(TemplatePatternTimeout);
      } finally {
        watchdog.mockRestore();
      }
    },
  );
});
