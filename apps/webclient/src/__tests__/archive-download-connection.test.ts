import { describe, expect, it, vi } from 'vitest';
import { connectArchiveDownloadSocket } from '../settings/archive-download-connection.js';

class Socket extends EventTarget {
  sent: string[] = []; closes = 0;
  send(text: string): void { this.sent.push(text); }
  close(): void { this.closes++; this.dispatchEvent(new Event('close')); }
  open(): void { this.dispatchEvent(new Event('open')); }
  raw(): WebSocket { return this as unknown as WebSocket; }
}

const setup = (socket = new Socket(), controller = new AbortController()) => {
  const removed = vi.spyOn(socket, 'removeEventListener'), unlinked = vi.spyOn(controller.signal, 'removeEventListener');
  const result = connectArchiveDownloadSocket(socket.raw(), controller.signal);
  const clean = (): void => {
    expect(removed.mock.calls.map(([type]) => type)).toEqual(['open', 'error', 'close']);
    expect(unlinked.mock.calls.map(([type]) => type)).toEqual(['abort']);
  };
  return { socket, controller, result, clean };
};

describe('download connection ownership', () => {
  it('hands an opened socket to the driver and adapts data and terminal events', async () => {
    const h = setup(); h.socket.open(); const port = await h.result; h.clean();
    const text = vi.fn(), binary = vi.fn(), closed = vi.fn(), error = vi.fn(); port.onText(text); port.onBinary(binary); port.onClose(closed); port.onError(error);
    const bytes = new Uint8Array([1, 2]).buffer;
    h.socket.dispatchEvent(new MessageEvent('message', { data: 'control' })); h.socket.dispatchEvent(new MessageEvent('message', { data: bytes })); h.socket.dispatchEvent(new MessageEvent('message', { data: { ignored: true } }));
    port.send('start'); h.socket.dispatchEvent(new Event('error')); port.close();
    expect(h.socket.sent).toEqual(['start']); expect(text).toHaveBeenCalledExactlyOnceWith('control'); expect(binary).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(error).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce(); expect(h.socket.closes).toBe(1);
  });

  it('closes and refuses a socket when setup is already cancelled', async () => {
    const controller = new AbortController(); controller.abort(); const h = setup(new Socket(), controller);
    await expect(h.result).rejects.toThrow('cancelled'); expect(h.socket.closes).toBe(1); h.clean(); h.socket.open(); expect(h.socket.sent).toEqual([]);
  });

  it('closes pending setup immediately on abort and removes all setup listeners', async () => {
    const h = setup(), rejected = expect(h.result).rejects.toThrow('cancelled'); h.controller.abort(); await rejected; h.clean();
    h.socket.open(); h.socket.dispatchEvent(new Event('error')); expect(h.socket.closes).toBe(1); expect(h.socket.sent).toEqual([]);
  });

  it.each(['error', 'close'])('refuses a socket that reports %s before opening', async event => {
    const h = setup(), rejected = expect(h.result).rejects.toThrow('connection'); h.socket.dispatchEvent(new Event(event)); await rejected; h.clean();
    h.controller.abort(); h.socket.open(); expect(h.socket.closes).toBe(event === 'error' ? 1 : 0); expect(h.socket.sent).toEqual([]);
  });

  it('still rejects and cleans up when closing an aborted socket throws', async () => {
    const socket = new Socket(); vi.spyOn(socket, 'close').mockImplementation(() => { throw new Error('already closed'); });
    const h = setup(socket), rejected = expect(h.result).rejects.toThrow('cancelled'); h.controller.abort(); await rejected; h.clean();
  });

  it('lets cancellation win when another open listener aborts setup', async () => {
    const socket = new Socket(), controller = new AbortController(); socket.addEventListener('open', () => controller.abort());
    const h = setup(socket, controller), rejected = expect(h.result).rejects.toThrow('cancelled'); socket.open(); await rejected; h.clean(); expect(socket.closes).toBe(1);
  });

  it('removes setup cancellation after open so the driver owns later closure', async () => {
    const h = setup(); h.socket.open(); const port = await h.result; h.controller.abort(); expect(h.socket.closes).toBe(0); h.clean(); port.close(); expect(h.socket.closes).toBe(1);
  });
});
