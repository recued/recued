import { IngredientError } from '@recued/ingredients';
import { browserAddressKey } from '@recued/contracts';
import { browserPageOwner, browserTabKey } from './browser-routing.js';

interface Binding { page: string; first_page: string; url: string; aliases: Set<string>; at: number; uncertain: boolean }

/** Caller/turn-scoped navigation lineage. URLs bootstrap a flow; its unique
 * observed tab can continue after navigation. Never guesses between tabs or
 * browsers, and never turns an uncertain action into permission to replay it. */
export const createBrowserContinuations = (now: () => number = Date.now) => {
  const scopes = new Map<string, Map<string, Binding>>();
  const sweep = () => {
    let count = 0;
    for (const [scope, tabs] of scopes) {
      for (const [key, binding] of tabs) {
        if (now() - binding.at >= 10 * 60_000 || ++count > 512) tabs.delete(key);
      }
      if (!tabs.size) scopes.delete(scope);
    }
  };
  return {
    observe(scope: string, output: unknown, alias?: unknown, confirmedRead = false) {
      sweep();
      if (!output || typeof output !== 'object' || Array.isArray(output)) return;
      const out = output as Record<string, unknown>;
      if (typeof out.page !== 'string' || typeof out.url !== 'string' || !browserAddressKey(out.url)) return;
      if (!browserPageOwner(out.page) && !/^\d{1,10}:[\w-]{1,128}$/.test(out.page)) return;
      const tabs = scopes.get(scope) ?? new Map<string, Binding>(); scopes.set(scope, tabs);
      const key = browserTabKey(out.page), existing = tabs.get(key);
      const aliases = existing?.aliases ?? new Set<string>();
      aliases.add(browserAddressKey(out.url)!);
      if (typeof alias === 'string' && browserAddressKey(alias)) aliases.add(browserAddressKey(alias)!);
      while (aliases.size > 32) aliases.delete(aliases.values().next().value!);
      tabs.set(key, { page: out.page, first_page: existing?.first_page ?? out.page, url: out.url, aliases, at: now(), uncertain: existing?.uncertain === true && !confirmedRead });
    },
    uncertain(scope: string, page: string) {
      const binding = scopes.get(scope)?.get(browserTabKey(page));
      if (binding) binding.uncertain = true;
    },
    resolve(scope: string, address: string, bridge?: string): { page: string; url: string; moved: boolean } | undefined {
      sweep();
      const key = browserAddressKey(address); if (!key) return;
      const matches = [...(scopes.get(scope)?.values() ?? [])].filter(binding => binding.aliases.has(key)
        && (!bridge || browserPageOwner(binding.page)?.bridge_id === bridge));
      if (!matches.length) return;
      if (matches.length > 1) throw new IngredientError('DOM_PAGE_NOT_MATCHING',
        `This URL belongs to more than one observed browser tab. Choose an exact page handle before continuing: ${matches.slice(0, 4).map(binding => binding.page).join(', ')}`,
        { executed: false, pages: matches.slice(0, 4).map(binding => ({ page: binding.page, url: binding.url })) });
      const binding = matches[0]!;
      if (binding.uncertain) throw new IngredientError('DOM_PAGE_NOT_MATCHING',
        `The last action on this tab is uncertain. Inspect ${binding.page} before continuing; no action was replayed.`, { executed: false, page: binding.page });
      return { page: binding.page, url: binding.url, moved: binding.page !== binding.first_page || browserAddressKey(binding.url) !== key };
    },
  };
};

/** Recipe executors/adapters are recreated per run. The stable late-bound
 * dispatcher accessor identifies their server runtime, including before pairing.
 * Weak ownership lets an entire stopped runtime and its lineage be collected;
 * bindings inside it remain caller/turn scoped, bounded and expiring. */
const runtimes = new WeakMap<object, ReturnType<typeof createBrowserContinuations>>();
export const browserContinuationsFor = (runtime: object): ReturnType<typeof createBrowserContinuations> => {
  let continuations = runtimes.get(runtime);
  if (!continuations) { continuations = createBrowserContinuations(); runtimes.set(runtime, continuations); }
  return continuations;
};
