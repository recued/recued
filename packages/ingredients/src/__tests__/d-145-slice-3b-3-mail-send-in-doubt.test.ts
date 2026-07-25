/** D-145 engine-wiring slice 3b.3 — mail-send uncertain delivery mapping. */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkMailSendCall = (): ResolvedCall => ({
  slug: 'mail-send',
  risk_tier: 'write',
  input: {
    sender_mail_instance: 'work',
    to: ['ada@example.com'],
    subject: 'Hello',
    body: 'Body',
  },
  output: {},
  manifest_version: 1,
} as ResolvedCall & { manifest_version: number });

describe('createKernelAdapter mail-send D-145 slice 3b.3', () => {
  it('normalizes MAIL_SEND_NETWORK_FAILED into ACTION_DELIVERY_UNCERTAIN', async () => {
    const original = new IngredientError(
      'MAIL_SEND_NETWORK_FAILED',
      'provider accepted unknown outcome',
      { provider: 'gmail' },
    );
    const adapter = createKernelAdapter({
      mailSend: async () => {
        throw original;
      },
    });

    await expect(adapter(mkMailSendCall())).rejects.toBeInstanceOf(IngredientError);
    try {
      await adapter(mkMailSendCall());
      throw new Error('expected mail-send to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect(err).not.toBe(original);
      const ingredientError = err as IngredientError;
      expect(ingredientError.code).toBe('ACTION_DELIVERY_UNCERTAIN');
      expect(ingredientError.message).toBe(original.message);
      expect(ingredientError.details?.mail_send_code).toBe('MAIL_SEND_NETWORK_FAILED');
      expect(ingredientError.details?.slug).toBe('mail-send');
      expect(ingredientError.details?.provider).toBe('gmail');
    }
  });

  it('propagates confirmed mail-send IngredientError codes unchanged', async () => {
    const original = new IngredientError(
      'MAIL_SEND_AUTH_FAILED',
      'auth expired',
      { slug: 'mail-send' },
    );
    const adapter = createKernelAdapter({
      mailSend: async () => {
        throw original;
      },
    });

    await expect(adapter(mkMailSendCall())).rejects.toBe(original);
  });

  it('propagates non-IngredientError throws unchanged', async () => {
    const original = new Error('plain transport wrapper failed');
    const adapter = createKernelAdapter({
      mailSend: async () => {
        throw original;
      },
    });

    await expect(adapter(mkMailSendCall())).rejects.toBe(original);
  });
});
