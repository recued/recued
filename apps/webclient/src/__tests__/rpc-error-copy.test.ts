/** RPC-error classifier acceptance — humanized copy + connection routing. */

import { afterEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  noteDialledServerUrl,
  resetInsecureOriginProbeForTest,
} from '../net/insecure-origin.js';
import {
  classifyRpcError,
  humanizeRpcError,
  resolveSurfaceErrorDisplay,
  type SurfaceErrorEntry,
} from '../shell/rpc-error-copy.js';

const rpc = (code: string, message: string): RpcError =>
  new RpcError(code, message, undefined, 'approval.list');

/** ⛔ THE COPY THAT WAS WRONG. A socket the BROWSER refuses (an insecure dial
 *  from a secure page) arrives here as the same `server_offline` a dead host
 *  produces — close 1006, no status, no headers. The old answer, "Can't reach
 *  your server right now", sent owners to check a server that was running and
 *  answering. These pin the refinement AND its blast radius: only `offline`
 *  moves, and only while the page/address combination actually explains it. */
describe('classifyRpcError — a browser-blocked connection', () => {
  const stubSecurePage = (): void => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:' },
      configurable: true,
      writable: true,
    });
  };
  const stubInsecurePage = (): void => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'http:' },
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    resetInsecureOriginProbeForTest();
  });

  it('names the browser when an https page dialled a NON-loopback ws:// address', () => {
    stubSecurePage();
    noteDialledServerUrl('ws://192.168.1.42:7717/ws');
    const c = classifyRpcError(rpc('server_offline', 'webclient rpc: server offline'));
    expect(c.kind).toBe('offline');
    expect(c.copy).toMatch(/browser blocked this/i);
    // It must say what to DO, not just what happened.
    expect(c.copy).toMatch(/Open Recued from your server|certificate/i);
    expect(c.copy).not.toMatch(/Can't reach your server right now/);
  });

  it('keeps the plain offline copy for a LOOPBACK failure — the browser is not to blame', () => {
    // ⛔ Regression: this said "this browser blocked the connection" for every
    // failed connection to a local server, which Chrome permits. The honest
    // answer when we cannot tell is the plain one.
    stubSecurePage();
    noteDialledServerUrl('ws://127.0.0.1:7717/ws');
    expect(classifyRpcError(rpc('server_offline', 'x')).copy)
      .toBe("Can't reach your server right now.");
  });

  it('keeps the plain offline copy when the page is not secure', () => {
    // The local webclient: same origin, plain http, nothing blocked. If the
    // server is down here it really IS down.
    stubInsecurePage();
    noteDialledServerUrl('ws://127.0.0.1:7717/ws');
    expect(classifyRpcError(rpc('server_offline', 'x')).copy)
      .toBe("Can't reach your server right now.");
  });

  it('keeps the plain offline copy when the dialled address is secure', () => {
    stubSecurePage();
    noteDialledServerUrl('wss://my.example.com/ws');
    expect(classifyRpcError(rpc('transport', 'x')).copy)
      .toBe("Can't reach your server right now.");
  });

  it('does NOT rewrite timeout, auth, or cancelled — each has its own evidence', () => {
    stubSecurePage();
    noteDialledServerUrl('ws://127.0.0.1:7717/ws');
    expect(classifyRpcError(rpc('timeout', 'x')).copy)
      .toBe("Your server isn't responding right now.");
    expect(classifyRpcError(rpc('webclient_reauth_required', 'x')).copy)
      .toBe('This browser has to be paired again.');
    expect(classifyRpcError(rpc('aborted', 'x')).copy).toBe('Cancelled.');
  });
});

describe('classifyRpcError', () => {
  it('maps server_offline to a calm offline copy with no internals', () => {
    const c = classifyRpcError(
      rpc('server_offline', "webclient rpc: server offline — 'approval.list' was not delivered"),
    );
    expect(c.kind).toBe('offline');
    expect(c.connectionCaused).toBe(true);
    expect(c.suppressible).toBe(false);
    expect(c.code).toBe('server_offline');
    // No method name, no code, no "rpc" jargon leaks into the user copy.
    expect(c.copy).not.toMatch(/approval\.list/);
    expect(c.copy).not.toMatch(/webclient rpc/i);
    expect(c.copy).not.toMatch(/server_offline/);
  });

  it('maps timeout to "unresponsive" and strips the millisecond duration', () => {
    const c = classifyRpcError(
      rpc('timeout', "webclient rpc: method 'approval.list' did not respond within 30000ms"),
    );
    expect(c.kind).toBe('unresponsive');
    expect(c.connectionCaused).toBe(true);
    expect(c.copy).not.toMatch(/30000ms/);
    expect(c.copy).not.toMatch(/approval\.list/);
  });

  it('maps server_unresponsive to the same calm "unresponsive" copy as timeout', () => {
    const c = classifyRpcError(
      rpc('server_unresponsive', "webclient rpc: server not responding — 'approval.list' not sent"),
    );
    expect(c.kind).toBe('unresponsive');
    expect(c.connectionCaused).toBe(true);
    // Same vocabulary as a real timeout — the half-open fast-fail just gets
    // there sooner. Never leaks the method name or the raw code.
    expect(c.copy).toBe(classifyRpcError(rpc('timeout', 'x')).copy);
    expect(c.copy).not.toMatch(/approval\.list/);
    expect(c.copy).not.toMatch(/server_unresponsive/);
  });

  it('maps connection_lost to an in-doubt copy', () => {
    const c = classifyRpcError(rpc('connection_lost', 'webclient rpc: connection lost — …'));
    expect(c.kind).toBe('in_doubt');
    expect(c.connectionCaused).toBe(true);
    expect(c.copy.toLowerCase()).toContain('does not know what happened');
  });

  it('maps transport to offline', () => {
    const c = classifyRpcError(rpc('transport', 'socket closed mid-write'));
    expect(c.kind).toBe('offline');
    expect(c.connectionCaused).toBe(true);
    expect(c.copy).not.toMatch(/socket/);
  });

  it('maps webclient_reauth_required to the auth class', () => {
    const c = classifyRpcError(rpc('webclient_reauth_required', 'bearer rotated'));
    expect(c.kind).toBe('auth');
    expect(c.connectionCaused).toBe(true);
  });

  it('treats teardown/abort as suppressible + NOT a connection outage', () => {
    const disposed = classifyRpcError(rpc('transport_disposed', 'conn disposed'));
    expect(disposed.kind).toBe('cancelled');
    expect(disposed.suppressible).toBe(true);
    expect(disposed.connectionCaused).toBe(false);
    const aborted = classifyRpcError(rpc('aborted', 'aborted by caller'));
    expect(aborted.kind).toBe('cancelled');
    expect(aborted.suppressible).toBe(true);
    expect(aborted.connectionCaused).toBe(false);
  });

  it('passes a real server error through as an inline-showable message', () => {
    const c = classifyRpcError(rpc('bad_request', 'A name is required.'));
    expect(c.kind).toBe('error');
    expect(c.connectionCaused).toBe(false);
    expect(c.copy).toBe('A name is required.'); // server's own copy, shown as-is
    expect(c.code).toBe('bad_request');
  });

  it('handles a plain Error (no code) as a generic error', () => {
    const c = classifyRpcError(new Error('file could not be read'));
    expect(c.kind).toBe('error');
    expect(c.code).toBeNull();
    expect(c.connectionCaused).toBe(false);
    expect(c.copy).toBe('file could not be read');
  });

  it('handles a structural { code } that is not an RpcError instance', () => {
    const c = classifyRpcError({ code: 'server_offline', message: 'x' });
    expect(c.kind).toBe('offline');
    expect(c.connectionCaused).toBe(true);
  });

  it('handles a non-Error value', () => {
    const c = classifyRpcError('boom');
    expect(c.kind).toBe('error');
    expect(c.copy).toBe('boom');
  });

  it('humanizeRpcError returns the copy string', () => {
    expect(humanizeRpcError(rpc('server_offline', 'raw'))).toBe(
      classifyRpcError(rpc('server_offline', 'raw')).copy,
    );
  });
});

describe('resolveSurfaceErrorDisplay (Tier 2 routing)', () => {
  const entry = (code: string, message: string, label: string): SurfaceErrorEntry => ({
    error: classifyRpcError(rpc(code, message)),
    label,
  });

  it('returns null when there are no errors', () => {
    expect(resolveSurfaceErrorDisplay([], { hasData: false })).toBeNull();
    expect(resolveSurfaceErrorDisplay([null, null], { hasData: true })).toBeNull();
  });

  it('connection-only + has data → null (keep the stale data, defer to banner)', () => {
    const out = resolveSurfaceErrorDisplay(
      [entry('server_offline', 'raw', "Couldn't load approvals")],
      { hasData: true },
    );
    expect(out).toBeNull();
  });

  it('connection-only + NO data → one calm line, flagged connectionCaused', () => {
    const out = resolveSurfaceErrorDisplay(
      [entry('server_offline', 'raw', "Couldn't load approvals")],
      { hasData: false },
    );
    expect(out).not.toBeNull();
    expect(out!.connectionCaused).toBe(true);
    expect(out!.text).toBe("Can't reach your server right now.");
    // No context label prefix + no raw internals on the connection line.
    expect(out!.text).not.toMatch(/Couldn't load approvals:/);
    expect(out!.text).not.toMatch(/raw/);
  });

  it('a real error always shows inline (labelled), even alongside a connection error', () => {
    const out = resolveSurfaceErrorDisplay(
      [
        entry('server_offline', 'raw', "Couldn't load approvals"),
        entry('bad_request', 'A name is required.', "Couldn't answer"),
      ],
      { hasData: false },
    );
    expect(out).not.toBeNull();
    expect(out!.connectionCaused).toBe(false);
    expect(out!.text).toBe("Couldn't answer: A name is required.");
  });

  it('a real error with no label shows the bare humanized copy (no ": " prefix)', () => {
    const out = resolveSurfaceErrorDisplay(
      [{ error: classifyRpcError(rpc('bad_request', 'A name is required.')) }],
      { hasData: false },
    );
    expect(out!.text).toBe('A name is required.');
  });

  it('an ACTION failure always shows inline — even connection-caused, even with data', () => {
    const out = resolveSurfaceErrorDisplay(
      [
        {
          error: classifyRpcError(rpc('connection_lost', 'raw')),
          label: "Couldn't send",
          origin: 'action',
        },
      ],
      { hasData: true }, // data present + connection-caused → would be suppressed as a LOAD
    );
    expect(out).not.toBeNull();
    // Shown inline (alert tone), with the in-doubt warning the user must see.
    expect(out!.connectionCaused).toBe(false);
    expect(out!.text).toBe(
      "Couldn't send: The connection dropped before this finished, so Recued does not know what happened.",
    );
  });

  it('a connection LOAD failure still defers (data present) — origin defaults to load', () => {
    const out = resolveSurfaceErrorDisplay(
      [{ error: classifyRpcError(rpc('server_offline', 'raw')), label: 'Load' }],
      { hasData: true },
    );
    expect(out).toBeNull();
  });

  it('suppressible (teardown/abort) errors are ignored entirely', () => {
    const out = resolveSurfaceErrorDisplay(
      [entry('transport_disposed', 'disposed', 'X'), entry('aborted', 'a', 'Y')],
      { hasData: false },
    );
    expect(out).toBeNull();
  });
});
