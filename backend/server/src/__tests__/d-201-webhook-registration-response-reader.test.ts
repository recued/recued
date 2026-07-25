import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookRegistrationJsonResponseReader,
} from '../webhook-registration-json-response-reader.js';
import {
  WEBHOOK_REGISTRATION_RESPONSE_PROFILE_PRESETS,
  webhookRegistrationResponseProfilePreset,
} from '../webhook-registration-response-profile-presets.js';

const PRESET = {
  kind: 'bounded_json_response.v1',
  max_bytes: 512 * 1024,
  error_label: 'Fixture registration',
} as const;

const pending = (response: Response) => ({
  response,
  finish: vi.fn(),
});

describe('D-201 Slices 9AF-9AI bounded registration JSON-response reader', () => {
  it('reads chunked response bytes and admits any valid JSON root', async () => {
    const reader = createWebhookRegistrationJsonResponseReader(PRESET);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"ok":'));
        controller.enqueue(new TextEncoder().encode('true}]'));
        controller.close();
      },
    });
    const response = pending(new Response(stream));

    await expect(reader.readJson(response)).resolves.toEqual([{ ok: true }]);
    expect(response.finish).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Object.isFrozen(reader.preset)).toBe(true);
    expect(() => JSON.stringify(reader.preset)).not.toThrow();
  });

  it('finishes a bodyless response and returns exact empty text', async () => {
    const reader = createWebhookRegistrationJsonResponseReader(PRESET);
    const response = pending(new Response(null, { status: 204 }));

    await expect(reader.readText(response)).resolves.toBe('');
    expect(response.finish).toHaveBeenCalledTimes(1);
  });

  it('fails closed on invalid UTF-8 and malformed JSON after finishing', async () => {
    const reader = createWebhookRegistrationJsonResponseReader(PRESET);
    const invalidUtf8 = pending(new Response(new Uint8Array([0xff])));
    const malformedJson = pending(new Response('{"ok":'));

    await expect(reader.readJson(invalidUtf8)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Fixture registration returned invalid UTF-8',
    });
    await expect(reader.readJson(malformedJson)).rejects.toMatchObject({
      code: 'upstream_response_invalid',
      message: 'Fixture registration returned malformed JSON',
    });
    expect(invalidUtf8.finish).toHaveBeenCalledTimes(1);
    expect(malformedJson.finish).toHaveBeenCalledTimes(1);
  });

  it('cancels oversized streams and maps stream failures without leaking errors', async () => {
    const reader = createWebhookRegistrationJsonResponseReader({
      ...PRESET,
      max_bytes: 4,
    });
    const cancel = vi.fn();
    const oversized = pending(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('12'));
        controller.enqueue(new TextEncoder().encode('345'));
      },
      cancel,
    })));
    const failed = pending(new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('provider body detail must not escape');
      },
    })));

    await expect(reader.readText(oversized)).rejects.toMatchObject({
      code: 'upstream_response_too_large',
      message: 'Fixture registration response exceeded the size limit',
    });
    await expect(reader.readText(failed)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'Fixture registration response did not complete',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(oversized.finish).toHaveBeenCalledTimes(1);
    expect(failed.finish).toHaveBeenCalledTimes(1);
  });

  it('normalizes reader-acquisition failure and still releases request cleanup', async () => {
    const reader = createWebhookRegistrationJsonResponseReader(PRESET);
    const response = new Response('[]');
    const heldReader = response.body!.getReader();
    const locked = pending(response);

    await expect(reader.readJson(locked)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'Fixture registration response did not complete',
    });
    expect(locked.finish).toHaveBeenCalledTimes(1);
    heldReader.releaseLock();
  });

  it('accepts only exact bounded trusted presets without executing accessors', () => {
    expect(() => createWebhookRegistrationJsonResponseReader(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_json_response.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 1024 * 1024 + 1 },
      { ...PRESET, max_bytes: 1.5 },
      { ...PRESET, error_label: '' },
      { ...PRESET, error_label: 'line\nbreak' },
      { ...PRESET, error_label: 'é' },
      { ...PRESET, error_label: 'x'.repeat(129) },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile response preset');
        },
      }),
    ]) {
      expect(() => createWebhookRegistrationJsonResponseReader(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 512 * 1024);
    const accessor = {
      kind: 'bounded_json_response.v1',
      error_label: 'Fixture registration',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookRegistrationJsonResponseReader(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds vendor response limits and diagnostics through trusted profile data', () => {
    const github = webhookRegistrationResponseProfilePreset(
      'github.webhook.v1',
    );
    expect(github).toEqual({
      profile_id: 'github.webhook.v1',
      reader: {
        kind: 'bounded_json_response.v1',
        max_bytes: 512 * 1024,
        error_label: 'GitHub webhook registration',
      },
    });
    const paddle = webhookRegistrationResponseProfilePreset(
      'paddle.notification.v1',
    );
    expect(paddle).toEqual({
      profile_id: 'paddle.notification.v1',
      reader: {
        kind: 'bounded_json_response.v1',
        max_bytes: 512 * 1024,
        error_label: 'Paddle webhook registration',
      },
    });
    const telegram = webhookRegistrationResponseProfilePreset(
      'telegram.bot-webhook.v1',
    );
    expect(telegram).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      reader: {
        kind: 'bounded_json_response.v1',
        max_bytes: 128 * 1024,
        error_label: 'Telegram webhook registration',
      },
    });
    const stripe = webhookRegistrationResponseProfilePreset(
      'stripe.event.v1',
    );
    expect(stripe).toEqual({
      profile_id: 'stripe.event.v1',
      reader: {
        kind: 'bounded_json_response.v1',
        max_bytes: 512 * 1024,
        error_label: 'Stripe webhook registration',
      },
    });
    expect(webhookRegistrationResponseProfilePreset(
      'slack.request.v0',
    )).toBeNull();
    expect(Object.keys(WEBHOOK_REGISTRATION_RESPONSE_PROFILE_PRESETS))
      .toEqual([
        'github.webhook.v1',
        'paddle.notification.v1',
        'telegram.bot-webhook.v1',
        'stripe.event.v1',
      ]);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_RESPONSE_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_RESPONSE_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(github)).toBe(true);
    expect(Object.isFrozen(github?.reader)).toBe(true);
    expect(Object.isFrozen(paddle)).toBe(true);
    expect(Object.isFrozen(paddle?.reader)).toBe(true);
    expect(Object.isFrozen(telegram)).toBe(true);
    expect(Object.isFrozen(telegram?.reader)).toBe(true);
    expect(Object.isFrozen(stripe)).toBe(true);
    expect(Object.isFrozen(stripe?.reader)).toBe(true);
    expect(() => JSON.stringify([github, paddle, telegram, stripe])).not.toThrow();
  });
});
