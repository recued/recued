/** `recued-server pair` — print a fresh pairing code + reachable URLs.
 *
 *  Spec ref: D-121 § "Server CLI refresh".
 *
 *  Default form (`recued-server pair`) and explicit `pair generate` are
 *  identical: refresh the pairing code, list reachable server URLs, and
 *  print the `app.recued.com/pair` deeplink. The deeplink rides the
 *  `?code=` query unless `--no-url-prefill` is passed (per spec § "URL
 *  enumeration" / "--no-url-prefill flag").
 *
 *  Each invocation emits to stdout and returns immediately — daemon
 *  model. No `[Enter]`, no `[Ctrl+C]`, no clipboard mutation.
 */

import type { PairingManager } from '../pairing.js';
import type { RecoveryKeyCheckStore } from '../recovery-key-store.js';
import {
  enumerateServerUrls,
  formatUrlList,
  type EnumerateConfig,
  type EnumerateDeps,
} from '../cli/url-enumerate.js';

export interface PairCommandDeps {
  pairing: PairingManager;
  recoveryKeyCheck?: RecoveryKeyCheckStore;
  /** Enumeration config — backed by the parsed runtime config. */
  enumerate?: EnumerateConfig;
  /** Override hooks for tests + the EnumerateDeps shape. */
  enumerateDeps?: EnumerateDeps;
}

export interface PairCommandOptions {
  /** When true, omit the `?code=` query from the app.recued.com/pair
   *  deeplink and print the code on its own line. */
  noUrlPrefill?: boolean;
  /** Webapp base URL for the deeplink. Defaults to
   *  `https://app.recued.com/pair`. Tests override; deployments may
   *  swap to an internal staging origin. */
  webappBaseUrl?: string;
  /** Subcommand selector — `'generate'` (default) is the only form
   *  today; the spec leaves room for future ones. */
  subcommand?: 'generate';
  /** Output sink — defaults to `console.log`. Tests inject. */
  out?: (line: string) => void;
}

const DEFAULT_WEBAPP_PAIR_URL = 'https://app.recued.com/pair';

export async function cmdPair(
  deps: PairCommandDeps,
  options: PairCommandOptions = {},
): Promise<void> {
  const out = options.out ?? ((line: string) => { console.log(line); });
  const code = deps.pairing.refreshCode();
  const remainingMin = Math.max(1, Math.floor(deps.pairing.timeRemaining() / 60_000));
  const ttlLabel = remainingMin >= 60
    ? `${Math.floor(remainingMin / 60)} hour${remainingMin >= 120 ? 's' : ''}`
    : `${remainingMin} min`;

  out('');
  out(`  Pairing code: ${code}   (TTL ${ttlLabel})`);
  out('');

  if (deps.enumerate) {
    const urls = await enumerateServerUrls(deps.enumerate, deps.enumerateDeps);
    out('  Server reachable at:');
    out(formatUrlList(urls));
    out('');
  }

  const webappBase = options.webappBaseUrl ?? DEFAULT_WEBAPP_PAIR_URL;
  if (options.noUrlPrefill) {
    out(`  Open ${webappBase} to complete pairing.`);
    out(`  Then enter the code above on the webapp.`);
  } else {
    const link = `${webappBase}?code=${encodeURIComponent(code)}`;
    out(`  Open ${link} to complete pairing.`);
  }

  if (deps.recoveryKeyCheck && !deps.recoveryKeyCheck.exists()) {
    out('');
    out('  This server has not been enrolled yet. Your first pair');
    out('  also seeds the recovery key — the webapp prompts for it.');
  }
}
