/** `net/insecure-origin.ts` — the "this browser refused it" predicate.
 *
 *  The behaviour under test is a DIAGNOSIS, not a gate: it never blocks a
 *  connection, it only decides which explanation a failure gets. So the cases
 *  that matter most are the ones where it must stay SILENT — a secure server
 *  address, an insecure page, an unparseable stored URL — because a false
 *  positive here would tell an owner their browser is at fault when their
 *  server is genuinely down. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  dialledServerUrl,
  isBrowserSocketRefusal,
  isCertainlyBlockedServerAddress,
  isConnectionBlockedByBrowserOrigin,
  isInsecureSocketFromSecurePage,
  isSocketRefusalProven,
  noteBrowserRefusedSocket,
  noteDialledServerUrl,
  readPageProtocol,
  resetInsecureOriginProbeForTest,
} from './insecure-origin.js';

afterEach(() => {
  resetInsecureOriginProbeForTest();
});

const docWith = (protocol: string): Document =>
  ({ defaultView: { location: { protocol } } } as unknown as Document);

describe('isInsecureSocketFromSecurePage', () => {
  it('flags an http server address on an https page', () => {
    expect(isInsecureSocketFromSecurePage('http://192.168.1.42:7717', 'https:')).toBe(true);
  });

  it('flags a ws:// address too — the form the transport actually dials', () => {
    expect(isInsecureSocketFromSecurePage('ws://127.0.0.1:7717/ws', 'https:')).toBe(true);
  });

  it('flags loopback as well, because the browser policy is not ours to guess', () => {
    // Chrome permits this; Safari and Firefox do not. We cannot sniff which,
    // and it is only consulted AFTER a failure — so a Chrome user who is
    // working never reaches it, and a Safari user who is not gets the answer.
    expect(isInsecureSocketFromSecurePage('http://127.0.0.1:7717', 'https:')).toBe(true);
    expect(isInsecureSocketFromSecurePage('http://localhost:7717', 'https:')).toBe(true);
  });

  it('stays silent when the server address is already secure', () => {
    expect(isInsecureSocketFromSecurePage('https://my.example.com', 'https:')).toBe(false);
    expect(isInsecureSocketFromSecurePage('wss://my.example.com/ws', 'https:')).toBe(false);
  });

  it('stays silent when the PAGE is not secure — nothing is being blocked', () => {
    // The local webclient case: served from the server over plain http, so the
    // origins match and no browser objects. Blaming the browser here would be
    // exactly backwards.
    expect(isInsecureSocketFromSecurePage('http://127.0.0.1:7717', 'http:')).toBe(false);
  });

  it('stays silent on an absent or unparseable address', () => {
    expect(isInsecureSocketFromSecurePage(null, 'https:')).toBe(false);
    expect(isInsecureSocketFromSecurePage('', 'https:')).toBe(false);
    expect(isInsecureSocketFromSecurePage('   ', 'https:')).toBe(false);
    expect(isInsecureSocketFromSecurePage('not a url', 'https:')).toBe(false);
  });
});

describe('isCertainlyBlockedServerAddress — the proactive half', () => {
  it('is certain about a NON-loopback http address on an https page', () => {
    // Mixed content is unconditional here: no browser permits it, so a form may
    // warn before the attempt without ever being wrong.
    expect(isCertainlyBlockedServerAddress('http://192.168.1.42:7717', 'https:')).toBe(true);
  });

  it('is NOT certain about loopback — Chrome allows it', () => {
    // The distinction this function exists for. Warning here would nag the one
    // configuration that works; loopback is diagnosed after a failure instead.
    expect(isCertainlyBlockedServerAddress('http://127.0.0.1:7717', 'https:')).toBe(false);
    expect(isCertainlyBlockedServerAddress('http://localhost:7717', 'https:')).toBe(false);
  });

  it('is silent for secure addresses and insecure pages', () => {
    expect(isCertainlyBlockedServerAddress('https://my.example.com', 'https:')).toBe(false);
    expect(isCertainlyBlockedServerAddress('http://192.168.1.42:7717', 'http:')).toBe(false);
  });

  it('is silent on a half-typed address', () => {
    // The field syncs on every keystroke, so it sees every prefix of what the
    // owner types. None of those may flash a warning.
    for (const partial of ['h', 'http', 'http:', 'http://', 'http://1']) {
      expect(isCertainlyBlockedServerAddress(partial, 'https:')).toBe(false);
    }
  });
});

describe('readPageProtocol', () => {
  it('reads the protocol from an injected document', () => {
    expect(readPageProtocol(docWith('https:'))).toBe('https:');
  });
});

describe('isBrowserSocketRefusal — the browser saying so itself', () => {
  it('recognises a SecurityError DOMException', () => {
    const err = new Error('Failed to construct WebSocket');
    err.name = 'SecurityError';
    expect(isBrowserSocketRefusal(err)).toBe(true);
  });

  it('recognises the message wording even without the name', () => {
    // Engines word this differently and the name is not guaranteed to survive
    // a re-throw, so either piece of evidence is enough on its own.
    expect(isBrowserSocketRefusal(new Error(
      "Failed to construct 'WebSocket': An insecure WebSocket connection may not "
      + 'be initiated from a page loaded over HTTPS.',
    ))).toBe(true);
  });

  it('ignores ordinary failures — a miss must not blame the browser', () => {
    expect(isBrowserSocketRefusal(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isBrowserSocketRefusal(new TypeError('Failed to fetch'))).toBe(false);
    expect(isBrowserSocketRefusal(null)).toBe(false);
    expect(isBrowserSocketRefusal('SecurityError')).toBe(false);
  });
});

describe('proof outranks the address heuristic', () => {
  it('reports blocked on an address the heuristic calls FINE', () => {
    // Chosen so the heuristic answers false on its own: a secure page dialling
    // a secure address. If this used loopback-on-https the heuristic would
    // already say true and the assertion would pass without the proof path
    // running at all — green, and evidence of nothing.
    noteDialledServerUrl('wss://my.example.com/ws');
    expect(isConnectionBlockedByBrowserOrigin(docWith('https:'))).toBe(false);

    noteBrowserRefusedSocket();
    expect(isConnectionBlockedByBrowserOrigin(docWith('https:'))).toBe(true);
  });

  it('starts unproven', () => {
    expect(isSocketRefusalProven()).toBe(false);
  });

  it('holds once set — the address and origin cannot change under the page', () => {
    noteBrowserRefusedSocket();
    expect(isSocketRefusalProven()).toBe(true);
    // Even with no address recorded at all.
    expect(isConnectionBlockedByBrowserOrigin(docWith('http:'))).toBe(true);
  });
});

describe('the dialled-address record', () => {
  it('starts empty, so a failure before any dial blames nobody', () => {
    expect(dialledServerUrl()).toBeNull();
    expect(isConnectionBlockedByBrowserOrigin(docWith('https:'))).toBe(false);
  });

  it('composes the record with the page protocol', () => {
    noteDialledServerUrl('ws://127.0.0.1:7717/ws');
    expect(isConnectionBlockedByBrowserOrigin(docWith('https:'))).toBe(true);
    expect(isConnectionBlockedByBrowserOrigin(docWith('http:'))).toBe(false);
  });

  it('follows the LATEST dial — a re-pair to a secure address clears it', () => {
    noteDialledServerUrl('ws://127.0.0.1:7717/ws');
    noteDialledServerUrl('wss://my.example.com/ws');
    expect(isConnectionBlockedByBrowserOrigin(docWith('https:'))).toBe(false);
  });
});
