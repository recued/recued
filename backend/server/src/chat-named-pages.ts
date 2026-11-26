/** D-335 slice AK — the pages a request names, read before its chat's first round.
 *
 *  browser-use opens the address in its task before its first model call, whose prompt held 15,000
 *  characters of the page (D-335 E, captured through a proxy 2026-11-06); Recued's first round saw
 *  only the request, and spent itself asking for a read. The owner: "#3 yes". While a Browser Bridge
 *  is connected, the owner's chat reads each page its message names by address (at most
 *  {@link NAMED_PAGES_MAX}) with Inspect a web page before the first round, side by side, as calls of
 *  the turn's own (recorded, audited and aliased as a model's are), when that read asks the owner
 *  nothing: a tab already shows the address, or the conversation's "Don't ask about browser actions"
 *  is on. A page that would have to be opened, and so asked about, is left to the model. */

import { browserAddressKey, browserAddressesMatch } from '@recued/contracts';

/** The most pages read before a first round: E's task A names three. */
export const NAMED_PAGES_MAX = 3;

/** What a turn that opens holding them is told. ⚠ Model-facing string — see
 *  `chat-prompt-optimization-log.md`. */
export const NAMED_PAGES_NOTE = 'The web addresses in this request were checked before this round with Inspect a web page. '
  + 'Use the opening results in prior_tool_calls. For browser_tab_choices, inspect the returned handles to identify the intended tab. '
  + 'For a usable read, continue from its page handle and refs.';

const count = (text: string, char: string): number => text.split(char).length - 1;

/** Each http or https address the message names, in order, once, at most {@link NAMED_PAGES_MAX}.
 *  Punctuation that ends the sentence is not the address's, nor is a closing bracket it does not
 *  open: "(https://en.wikipedia.org/wiki/Main_Page)." names the main page, and
 *  "…/wiki/Python_(programming_language)," the article. */
export const namedPageAddresses = (message: string): string[] => {
  const found: string[] = [];
  for (const match of message.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let address = match[0];
    for (;;) {
      const trimmed = address.replace(/[.,;:!?]+$/, '');
      const unopened = (trimmed.endsWith(')') && count(trimmed, ')') > count(trimmed, '('))
        || (trimmed.endsWith(']') && count(trimmed, ']') > count(trimmed, '['));
      const next = unopened ? trimmed.slice(0, -1) : trimmed;
      if (next === address) break;
      address = next;
    }
    if (browserAddressKey(address) === undefined || found.some((seen) => browserAddressesMatch(seen, address))) continue;
    found.push(address);
    if (found.length === NAMED_PAGES_MAX) break;
  }
  return found;
};

/** Which of `addresses` a read takes without asking the owner: every one while the conversation's
 *  request pass is on, since opening a page asks nothing then; else those a tab already shows, by
 *  the tabs the Bridge lists now; none when it cannot list them. */
export const readableNamedPages = async (addresses: readonly string[], deps: {
  connectedBridges?: () => number;
  requestPassLive: () => boolean;
  listTabs: () => Promise<ReadonlyArray<{ url: string }> | undefined>;
}): Promise<string[]> => {
  if (addresses.length === 0) return [];
  // A request pass waives an ask, not the choice of browser/account. Leave
  // multi-browser selection to the model and owner before the first read.
  if (deps.connectedBridges && deps.connectedBridges() !== 1) return [];
  if (deps.requestPassLive()) return [...addresses];
  const tabs = await deps.listTabs().catch(() => undefined);
  if (tabs === undefined) return [];
  return addresses.filter((address) => tabs.some((tab) => browserAddressesMatch(tab.url, address)));
};
