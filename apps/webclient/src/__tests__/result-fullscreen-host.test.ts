/** The fullscreen toggle's decisions, which are pure even though the API is not.
 *
 *  ⛔ The behaviour worth pinning is not "it calls requestFullscreen" — a stub
 *  would prove the call and not the message. It is: what happens when the
 *  platform refuses, which direction a click toggles when the document says
 *  something different from last time, and whether the label tells the truth
 *  after Escape.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RESULT_FULLSCREEN_ACTION,
  domFullscreenApi,
  resultFullscreenLabel,
  syncResultFullscreenChrome,
  toggleResultFullscreen,
  type ResultFullscreenApi,
} from '../recipes/result-fullscreen-host.js';
import { RECIPES_ROUTE_ACTION_ATTR } from '../recipes/recipe-result-panel.js';

const HOST = { id: 'host' } as unknown as Element;

const api = (over: Partial<ResultFullscreenApi> = {}): ResultFullscreenApi => ({
  supported: true,
  current: () => null,
  request: () => {},
  exit: () => {},
  ...over,
});

describe('result fullscreen toggle', () => {
  it('does nothing, and says so, where the platform refuses', async () => {
    const request = vi.fn();
    expect(await toggleResultFullscreen(HOST, api({ supported: false, request })))
      .toBe('unsupported');
    expect(request).not.toHaveBeenCalled();
  });

  it('enters when the document holds nothing, exits when it holds this host', async () => {
    const request = vi.fn();
    expect(await toggleResultFullscreen(HOST, api({ request }))).toBe('entered');
    expect(request).toHaveBeenCalledWith(HOST);

    const exit = vi.fn();
    expect(await toggleResultFullscreen(HOST, api({ current: () => HOST, exit })))
      .toBe('exited');
    expect(exit).toHaveBeenCalled();
  });

  it('enters when some OTHER element holds fullscreen', async () => {
    // Not "exit because something is fullscreen" — the host is not it.
    const request = vi.fn();
    const other = { id: 'other' } as unknown as Element;
    expect(await toggleResultFullscreen(HOST, api({ current: () => other, request })))
      .toBe('entered');
    expect(request).toHaveBeenCalledWith(HOST);
  });

  it('survives a rejected request instead of surfacing it', async () => {
    // No user activation, a denied iframe, a platform that refuses this element
    // — the panel staying its normal size IS the correct fallback.
    const outcome = await toggleResultFullscreen(HOST, api({
      request: () => Promise.reject(new Error('denied')),
    }));
    expect(outcome).toBe('failed');
  });

  it('labels the ACTION, never the state', () => {
    expect(resultFullscreenLabel(false)).toBe('Fullscreen');
    expect(resultFullscreenLabel(true)).toBe('Exit fullscreen');
  });

  it('re-reads the document when syncing, so Escape leaves a truthful label', () => {
    const attrs = new Map<string, string>();
    const button = {
      setAttribute: (k: string, v: string) => { attrs.set(k, v); },
      textContent: '',
    };
    const root = {
      querySelector: (selector: string) =>
        (selector === `[${RECIPES_ROUTE_ACTION_ATTR}="${RESULT_FULLSCREEN_ACTION}"]`
          ? (button as unknown as Element) : null),
    };
    syncResultFullscreenChrome(root, HOST, api({ current: () => HOST }));
    expect(attrs.get('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('Exit fullscreen');

    // Escape: the document no longer holds it, and nothing told the button.
    syncResultFullscreenChrome(root, HOST, api({ current: () => null }));
    expect(attrs.get('aria-pressed')).toBe('false');
    expect(button.textContent).toBe('Fullscreen');
  });

  it('reports unsupported when the document lacks the API', () => {
    expect(domFullscreenApi({}).supported).toBe(false);
    expect(domFullscreenApi({ fullscreenEnabled: true }).supported).toBe(false);
    expect(domFullscreenApi({
      fullscreenEnabled: true, exitFullscreen: () => Promise.resolve(),
    }).supported).toBe(true);
  });
});
