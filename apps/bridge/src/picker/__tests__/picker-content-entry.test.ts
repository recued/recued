import { afterEach, expect, it, vi } from 'vitest';
import type { StartPickerOverlayOptions } from '../overlay.js';

const { start, destroy } = vi.hoisted(() => ({ start: vi.fn(), destroy: vi.fn() }));
vi.mock('../overlay.js', () => ({ startPickerOverlay: start }));
afterEach(() => { vi.unstubAllGlobals(); });

it('takes the isolated launch credential once and returns it with a cancellation', async () => {
  vi.resetModules(); start.mockReset(); destroy.mockReset();
  start.mockReturnValue({ destroy });
  const send = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  vi.stubGlobal('__recuedElementPickerLaunch', { launch_id: 'launch', expires_at: Date.now() + 1_000 });
  vi.stubGlobal('__recuedElementPickerHandle', { destroy });
  await import('../picker-content-entry.js');
  expect(destroy).toHaveBeenCalledOnce();
  expect((globalThis as { __recuedElementPickerLaunch?: unknown }).__recuedElementPickerLaunch).toBeUndefined();
  (start.mock.calls[0]![0] as StartPickerOverlayOptions).onResult({ status: 'cancelled' });
  expect(send).toHaveBeenCalledWith({ type: 'recued.bridge.picker.result', launch_id: 'launch', result: { status: 'cancelled' } });
  vi.resetModules();
  await import('../picker-content-entry.js');
  expect(start).toHaveBeenCalledOnce();
});

it('does not start an overlay for an expired launch', async () => {
  vi.resetModules(); start.mockReset();
  vi.stubGlobal('__recuedElementPickerLaunch', { launch_id: 'expired', expires_at: Date.now() - 1 });
  await import('../picker-content-entry.js');
  expect(start).not.toHaveBeenCalled();
});
