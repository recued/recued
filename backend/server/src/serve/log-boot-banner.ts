export interface BootBannerLlmConfig {
  slot_1?: {
    provider: string;
    model: string;
  } | null;
}

export interface LogBootBannerOptions {
  /** Distribution version — `yy.mm.dd` (Pacific). Shown in the box. */
  version: string;
  port: number;
  /** True iff the bundled webclient is served at `/webclient/` on this server —
   *  gates whether the banner advertises the local webclient URL. */
  webclientServed: boolean;
  dbPath: string;
  recipeCount: number;
  llmConfig: BootBannerLlmConfig | undefined;
  pairingCode: string | null | undefined;
  /** Pre-formatted remaining window for `pairingCode` (e.g. '7 days').
   *  ⛔ The caller formats it: this module imports NOTHING by design, and a
   *  local copy of the formatter is what let the banner hard-code '15 min'
   *  while `recued pair` computed the real one on the same machine. */
  pairingTtlLabel?: string | null | undefined;
  notEnrolled: boolean;
  /** True when the owner's `privacy.auto_pii_protection` setting is OFF, so
   *  the dispatch seam does not alias PII (`isAutoPiiDisabled()`). Renders a
   *  standing warning block.
   *
   *  Why the banner cares: the hatch is legitimate (debugging / comparing model
   *  behaviour with and without aliasing), but its ONLY previous trace was the
   *  ABSENCE of auto-protection claims in recipe disclosures — a negative
   *  signal nobody notices. A server left with the hatch engaged sends
   *  unaliased PII to models and looks, from the terminal, exactly like one
   *  that does not. */
  autoPiiDisabled?: boolean;
  log?: (message?: unknown, ...optionalParams: unknown[]) => void;
}

/** The hosted webclient — always reachable, always a secure context. */
const HOSTED_WEBCLIENT_URL = 'https://app.recued.com';

/** The banner advertises LOOPBACK, never the LAN IP, for both the local
 *  webclient URL and the Server URL typed into it.
 *
 *  Not a display choice — a correctness one. A loopback origin is a SECURE
 *  CONTEXT, so `crypto.subtle` exists and the webclient boots; `http://<lan-ip>`
 *  is not, so the page loads and the app stops at the secure-context guard
 *  with no way forward on that origin. Printing the LAN URL here would be
 *  handing every operator a link that cannot work. Reaching the server from
 *  another device needs TLS in front (or a per-device browser opt-in) and
 *  lives in the docs, not on a line that reads like the happy path.
 *
 *  `127.0.0.1`, not `localhost`: the LAN listener binds `0.0.0.0` (IPv4), and
 *  `localhost` resolves to `::1` first on many systems. */
const LOOPBACK_HOST = '127.0.0.1';

const H = '\u2500';
const V = '\u2502';
const TL = '\u250c';
const TR = '\u2510';
const ML = '\u251c';
const MR = '\u2524';
const BL = '\u2514';
const BR = '\u2518';
const WARN = '\u26a0';
const EM_DASH = '\u2014';
const ELLIPSIS = '\u2026';

/** Cap on the box's inner content width \u2014 a longer value (e.g. a deep db path)
 *  is middle-ellipsized to fit rather than blowing the box out or overflowing
 *  the right border. */
const MAX_CONTENT = 52;

/** Middle-ellipsize to at most `max` chars, keeping the head + tail so a long
 *  path still shows its root and file name (`/tmp/\u2026/recued.db`). */
const ellipsize = (s: string, max: number): string => {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, Math.max(max, 0));
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}${ELLIPSIS}${s.slice(s.length - tail)}`;
};

export const renderBootBanner = (options: LogBootBannerOptions): string => {
  const {
    version,
    port,
    webclientServed,
    dbPath,
    recipeCount,
    llmConfig,
    pairingCode,
    pairingTtlLabel,
    notEnrolled,
    autoPiiDisabled,
  } = options;

  const status = notEnrolled ? 'Not enrolled' : 'Running';
  const llmLabel = llmConfig?.slot_1
    ? `${llmConfig.slot_1.provider}/${llmConfig.slot_1.model}`
    : 'not configured';

  // Build the label/value rows, align the value column, then size the box to
  // the widest row (capped) so every right border lands on the same column.
  //
  // No `Ingredients:` row. The count it would print is the manifest REGISTRY
  // size — kernel substrate (`KERNEL_MANIFESTS`, inlined in code) plus locally
  // authored bodies — not anything the owner installed, chose, or can act on.
  // It reads like inventory and is really a build constant, so the row was
  // dropped rather than left as decoration.
  const title = 'Recued Server';
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Version:', version],
    ['Port:', String(port)],
    ['Database:', dbPath],
    ['Recipes:', String(recipeCount)],
    ['LLM:', llmLabel],
    ['WebSocket:', '/ws'],
    ['Status:', status],
  ];
  const labelCol = Math.max(...rows.map(([label]) => label.length)) + 1;
  const bodies = rows.map(([label, value]) => {
    const prefix = label.padEnd(labelCol);
    return prefix + ellipsize(value, Math.max(MAX_CONTENT - prefix.length, 1));
  });
  const contentWidth = Math.min(
    Math.max(title.length, ...bodies.map((b) => b.length)),
    MAX_CONTENT,
  );
  const rule = (left: string, right: string): string => `${left}${H.repeat(contentWidth + 4)}${right}`;
  const line = (body: string): string => `${V}  ${body.padEnd(contentWidth)}  ${V}`;
  const box = [rule(TL, TR), line(title), rule(ML, MR), ...bodies.map(line), rule(BL, BR)];

  // Where to open the webclient.
  //
  // ⛔ THE LOCAL URL LEADS, AND THE ORDER IS THE POINT. Listing the hosted app
  // first read like the happy path and was not: a beginner picks it, then pastes
  // the LOOPBACK Server URL printed below into it, and that pairing is the one
  // combination that half-works. An `https://` page opening a `ws://` socket is
  // refused by the browser before a byte leaves it — Chrome permits it to
  // loopback, Safari and Firefox do not — and what the client sees is close 1006,
  // byte-for-byte an unplugged cable (`net/insecure-origin.ts`). The embedded
  // webclient has no such problem: it is SAME-ORIGIN with the server it pairs to.
  //
  // The hosted app is still named, because it is the only option when this build
  // ships no bundle — but it is named as what it is, not as the happy path.
  // Both URLs are loopback; see `LOOPBACK_HOST` for why the LAN address is
  // deliberately absent, and internal design notes D-272 for the fix.
  const localBase = `http://${LOOPBACK_HOST}:${port}`;
  const webclientTargets = webclientServed
    ? `     ${localBase}/webclient/`
    : `     ${HOSTED_WEBCLIENT_URL}
     ${WARN}  This build ships no embedded webclient, so the hosted app is the
        only option here. It reaches a loopback server on Chrome; Safari and
        Firefox refuse the connection.`;
  const openLabel = webclientServed
    ? 'Open Recued on this machine:'
    : 'Open the Recued webclient:';
  // Named on every boot so the answer to "how do I use my phone?" is never the
  // loopback URL above, which would load a page and then refuse to run.
  const otherDeviceBlock = `
  From another device (phone, another laptop): not yet ${EM_DASH} a browser needs a
  certificate to reach this server. Settings ${EM_DASH} Server ${EM_DASH} Connect a device.
`;

  const pairTtl = pairingTtlLabel ?? '15 min';

  const pairingBlock = notEnrolled
    ? `
  ${WARN}  Server is not encrypted yet ${EM_DASH} operations are blocked until you
     enrol a recovery key. Open the Recued webclient + pair a browser:

  ${openLabel}
${webclientTargets}

  Then, in the webclient:
  1. Server URL:    ${localBase}
     Pairing code:  ${pairingCode ? `${pairingCode}   (expires in ${pairTtl})` : `none live ${EM_DASH} run \`recued pair\` to mint one`}
  2. Choose "Generate a new one" to create your 24-word recovery key
     and write it down ${EM_DASH} or enter an existing key to re-pair.

  Pairing code expired? Run:  recued pair
${otherDeviceBlock}`
    : pairingCode ? `
  Add a browser ${EM_DASH} ${openLabel.toLowerCase()}
${webclientTargets}
  Then enter Server URL ${localBase} and the pairing code:
  Pairing code: ${pairingCode}  (expires in ${pairTtl})
${otherDeviceBlock}` : '';

  // Posture warning — printed on EVERY boot while the hatch is engaged, not
  // once at the moment it is set. An operator who inherits a server (or comes
  // back to one after a week) has no other way to learn that model egress is
  // running unaliased.
  const autoPiiBlock = autoPiiDisabled
    ? `
  ${WARN}  PII aliasing is OFF (Settings ${EM_DASH} Privacy).
     Recipes send personal data to models WITHOUT aliasing, and recipe
     disclosures will not claim auto-protection. Re-enable
     "Alias personal data before sending it to models" to restore it.
`
    : '';

  return `
  ${box.join('\n  ')}${pairingBlock}${autoPiiBlock}
  Press Ctrl+C to stop.
`;
};

export const logBootBanner = (options: LogBootBannerOptions): void => {
  const log = options.log ?? console.log;
  log(renderBootBanner(options));
};
