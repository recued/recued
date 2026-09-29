/** A free-pool entry's `id` is its name everywhere it shows: its row, its
 *  usage line, its Test result, and the Edit / Disable / Remove calls, which
 *  all address it by id.
 *
 *  ⛔ The server accepted a BLANK id, then refused its own Remove and Disable
 *  for it ("id must be a non-empty string"), and Settings drew the row with no
 *  buttons at all. An owner who left the ID field blank got an entry nothing
 *  could change, and a second blank-id add would have silently replaced it.
 *
 *  This names an entry the owner did not name: from where its traffic goes
 *  (`https://api.groq.com/openai/v1` → `groq`, anything on the owner's own
 *  network → `local`), else from its protocol (`anthropic`, `gemini`), kept
 *  clear of the names already `taken` with `-2`, `-3`… One function for the
 *  page that names a new entry and the server that names a stored blank one,
 *  so an entry gets the same name either way. */

import { isPrivateHost } from './connection-hints.js';

/** A Map, not an object literal: a provider string read off a stored entry
 *  must not find `constructor` on a prototype. */
const NAME_BY_PROTOCOL: ReadonlyMap<string, string> = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google', 'gemini'],
  ['openai-compatible', 'openai-compatible'],
]);

/** Lowercase letters, digits and single dashes, or undefined when nothing is
 *  left. A name, not an address: it shows in a row and in a button's label. */
const slug = (value: string): string | undefined => {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/u, '');
  return out.length > 0 ? out : undefined;
};

const nameFromBaseUrl = (baseUrl: string | undefined): string | undefined => {
  if (baseUrl === undefined || baseUrl.trim().length === 0) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.length === 0) return undefined;
  if (isPrivateHost(host)) return 'local';
  // Google serves Gemini's OpenAI-compatible endpoint from googleapis.com,
  // whose name before the suffix says nothing to an owner.
  if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) return 'gemini';
  // A public IP address is not a name; the protocol is a better one.
  if (/^[\d.]+$/u.test(host) || host.includes(':')) return undefined;
  const labels = host.split('.').filter((label) => label.length > 0);
  // The label before the suffix: api.groq.com → groq, openrouter.ai → openrouter.
  return slug(labels.length > 1 ? labels[labels.length - 2]! : labels[0]!);
};

export const suggestFreePoolEntryId = (
  entry: { provider?: string; base_url?: string },
  taken: ReadonlySet<string>,
): string => {
  const base = nameFromBaseUrl(entry.base_url)
    ?? (entry.provider !== undefined ? NAME_BY_PROTOCOL.get(entry.provider) : undefined)
    ?? 'entry';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};
