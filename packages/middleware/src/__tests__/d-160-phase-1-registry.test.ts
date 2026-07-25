/** D-160 P1 -- middleware registry.
 *
 *  Spec: docs/d-160-spec.md sections N.3 / A.3.
 */

import { describe, expect, it } from 'vitest';
import {
  createMiddlewareRegistry,
  type Middleware,
} from '@recued/middleware';

const middleware = (id: string): Middleware => ({ id });

describe('D-160 P1 createMiddlewareRegistry', () => {
  it('starts empty', () => {
    const registry = createMiddlewareRegistry();

    expect(registry.enabled()).toEqual([]);
    expect(registry.all()).toEqual([]);
    expect(registry.has('missing')).toBe(false);
  });

  it('registers middlewares enabled by default', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');

    registry.register(first);

    expect(registry.has('first')).toBe(true);
    expect(registry.isEnabled('first')).toBe(true);
    expect(registry.enabled()).toEqual([first]);
  });

  it('can register a middleware disabled', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');

    registry.register(first, { enabled: false });

    expect(registry.isEnabled('first')).toBe(false);
    expect(registry.enabled()).toEqual([]);
    expect(registry.all()).toEqual([{ middleware: first, enabled: false }]);
  });

  it('enable flips a registered disabled middleware on', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');
    registry.register(first, { enabled: false });

    registry.enable('first');

    expect(registry.isEnabled('first')).toBe(true);
    expect(registry.enabled()).toEqual([first]);
  });

  it('disable flips a registered enabled middleware off', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');
    registry.register(first);

    registry.disable('first');

    expect(registry.isEnabled('first')).toBe(false);
    expect(registry.enabled()).toEqual([]);
  });

  it('throws on duplicate ids', () => {
    const registry = createMiddlewareRegistry();
    registry.register(middleware('dup'));

    expect(() => registry.register(middleware('dup'))).toThrow(
      /already registered/,
    );
  });

  it('throws when enable, disable, or isEnabled target an unknown id', () => {
    const registry = createMiddlewareRegistry();

    expect(() => registry.enable('missing')).toThrow(/unknown middleware id/);
    expect(() => registry.disable('missing')).toThrow(/unknown middleware id/);
    expect(() => registry.isEnabled('missing')).toThrow(
      /unknown middleware id/,
    );
  });

  it('preserves registration order in enabled()', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');
    const second = middleware('second');
    const third = middleware('third');
    registry.register(first);
    registry.register(second, { enabled: false });
    registry.register(third);

    expect(registry.enabled()).toEqual([first, third]);
  });

  it('preserves registration order and flags in all()', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');
    const second = middleware('second');
    registry.register(first);
    registry.register(second, { enabled: false });

    expect(registry.all()).toEqual([
      { middleware: first, enabled: true },
      { middleware: second, enabled: false },
    ]);
  });

  it('returns fresh arrays so callers cannot mutate registry ordering', () => {
    const registry = createMiddlewareRegistry();
    const first = middleware('first');
    registry.register(first);

    const enabled = registry.enabled() as Middleware[];
    enabled.length = 0;

    expect(registry.enabled()).toEqual([first]);
  });
});
