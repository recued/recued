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
  /** LAN bind address the listener resolved to. Used for the local webclient
   *  URL + the Server URL the user enters in the webclient. Loopback when the
   *  interface is ambiguous (still valid for a same-machine browser). */
  lanBindAddress: string;
  /** True iff the bundled webclient is served at `/webclient/` on this server —
   *  gates whether the banner advertises the local webclient URL. */
  webclientServed: boolean;
  dbPath: string;
  recipeCount: number;
  ingredientCount: number;
  llmConfig: BootBannerLlmConfig | undefined;
  pairingCode: string | null | undefined;
  notEnrolled: boolean;
  log?: (message?: unknown, ...optionalParams: unknown[]) => void;
}

/** The hosted webclient — always reachable, always a secure context. */
const HOSTED_WEBCLIENT_URL = 'https://app.recued.com';

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
    lanBindAddress,
    webclientServed,
    dbPath,
    recipeCount,
    ingredientCount,
    llmConfig,
    pairingCode,
    notEnrolled,
  } = options;

  const status = notEnrolled ? 'Not enrolled' : 'Running';
  const llmLabel = llmConfig?.slot_1
    ? `${llmConfig.slot_1.provider}/${llmConfig.slot_1.model}`
    : 'not configured';

  // Build the label/value rows, align the value column, then size the box to
  // the widest row (capped) so every right border lands on the same column.
  const title = 'Recued Server';
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Version:', version],
    ['Port:', String(port)],
    ['Database:', dbPath],
    ['Recipes:', String(recipeCount)],
    ['Ingredients:', String(ingredientCount)],
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

  // Where to open the webclient. The hosted app is always reachable + a secure
  // context; the LOCAL bundled webclient is advertised only when this server
  // actually serves it (baked image / RECUED_WEBCLIENT_DIR). `lanBindAddress`
  // is the reachable host (loopback when the interface is ambiguous — still
  // valid for a same-machine browser) and is also the Server URL the user
  // types into the webclient (localhost would not reach it from a LAN device).
  const localBase = `http://${lanBindAddress}:${port}`;
  const webclientTargets = webclientServed
    ? `     ${HOSTED_WEBCLIENT_URL}   (hosted ${EM_DASH} any device)
     ${localBase}/webclient/   (this server)`
    : `     ${HOSTED_WEBCLIENT_URL}   (hosted ${EM_DASH} any device)`;

  const pairingBlock = notEnrolled
    ? `
  ${WARN}  Server is not encrypted yet ${EM_DASH} operations are blocked until you
     enrol a recovery key. Open the Recued webclient + pair a browser:

  Open the Recued webclient:
${webclientTargets}

  Then, in the webclient:
  1. Server URL:    ${localBase}
     Pairing code:  ${pairingCode}   (expires in 15 min)
  2. Choose "Generate a new one" to create your 24-word recovery key
     and write it down ${EM_DASH} or enter an existing key to re-pair.

  Pairing code expired? Run:  recued pair
`
    : pairingCode ? `
  Add a browser ${EM_DASH} open the Recued webclient:
${webclientTargets}
  Then enter Server URL ${localBase} and the pairing code:
  Pairing code: ${pairingCode}  (expires in 15 min)
` : '';

  return `
  ${box.join('\n  ')}${pairingBlock}
  Press Ctrl+C to stop.
`;
};

export const logBootBanner = (options: LogBootBannerOptions): void => {
  const log = options.log ?? console.log;
  log(renderBootBanner(options));
};
