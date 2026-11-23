/** D-402 slice H2 (§4.2 item 1, rule 14) — which of a recipe's settings name one of the owner's
 *  browsers, read from how its steps use them: a setting passed straight as a browser operation's
 *  `bridge_id`.
 *
 *  The setting holds the browser's lasting id (the paired instance, slice H1a), which routing resolves to
 *  its current pairing, so a credential rotation keeps it. A draft names one for each browser its job
 *  used (`plan-compiler.ts`), and the owner picks from their paired browsers in the dish's settings.
 *
 *  ⛔ NEVER A CALLER'S. A browser is the account a recipe acts in (D-349: an eligible browser is not the
 *  intended account), so its owner sets it per dish. A bare setting is never asked at a run (D-222), and
 *  the chat and MCP argument schema leaves it out (`chat-catalog.ts`), so no caller can set it either.
 *
 *  ⛔⛔ ONLY A BARE SETTING, AND THE DECLARATION DECIDES, NOT THE USE. A declared argument (a labeled
 *  value hint, or `null`, required from the caller) is the caller's to set, even when a step passes it
 *  straight as `bridge_id`: the Browser Toolkit's seven recipes do exactly that, and their `bridge_id` is
 *  the model's choice of browser for each call (D-349). Read from the use alone, slice H2a counted it,
 *  and the closed schema refused it from every AI caller until this was fixed (2026-11-18): with several
 *  browsers connected, routing asked the model to pass the one argument its schema refused.
 *
 *  Projected onto `recipe.list` rows by the server (`browser_settings`), as mailbox settings are: the
 *  steps it reads are not on a list row. One definition for both ends. */
import { kernelOpForBackingSlug } from './kernel-op-registry.js';

/** A setting whose value is one of the owner's browsers. */
export interface BrowserSetting {
  /** The setting's key in the recipe's `variables`. */
  readonly key: string;
}

/** D-402 slice H3 — a browser step that names its browser by a setting: what the check before step 1
 *  reads (`browser-step-check.ts`, server). One walk for both, so the settings a dish offers and the
 *  browsers a run checks are the same. */
export interface BrowserSettingStep {
  /** The step's id. */
  readonly step_id: string;
  /** Its `core.dom.*` op. */
  readonly op: string;
  /** The setting that names its browser. */
  readonly key: string;
  /** Its `target` as written: a site pattern, or a template the run resolves. */
  readonly target: unknown;
  /** Its arguments as written: what the check reads for the commands it will send (slice H3b). */
  readonly args: Readonly<Record<string, unknown>>;
}

const CONFIG_REF = /^\{\{config\.([A-Za-z0-9_]+)\}\}$/u;

type BrowserSettingsRecipe = {
  readonly steps?: readonly unknown[] | undefined;
  readonly prefetch_steps?: readonly unknown[] | undefined;
  /** What decides whose the setting is: only a bare value (a string, a draft's lasting id) is the dish's. */
  readonly variables?: Readonly<Record<string, unknown>> | undefined;
};

/** A browser step's op and arguments in either spelling: as authored (`op: 'core.dom.act'`, `args`), or
 *  as the server runs it once lowered (`ingredient: 'dom-act'`, `input`), which is what the check before
 *  step 1 reads. */
const browserStepOf = (step: Record<string, unknown>): { op: string; args: Record<string, unknown> } | undefined => {
  const { op, args, ingredient, input } = step as { op?: unknown; args?: unknown; ingredient?: unknown; input?: unknown };
  const named = typeof op === 'string' ? op : typeof ingredient === 'string' ? kernelOpForBackingSlug(ingredient) : undefined;
  const given = typeof op === 'string' ? args : input;
  if (named === undefined || !named.startsWith('core.dom.') || given === null || typeof given !== 'object' || Array.isArray(given)) return undefined;
  return { op: named, args: given as Record<string, unknown> };
};

/** Each browser step whose browser is a bare setting, in the order the run reaches them. */
export const recipeBrowserSteps = (recipe: BrowserSettingsRecipe): BrowserSettingStep[] => {
  const found: BrowserSettingStep[] = [];
  for (const step of [...(recipe.prefetch_steps ?? []), ...(recipe.steps ?? [])]) {
    if (step === null || typeof step !== 'object') continue;
    const browser = browserStepOf(step as Record<string, unknown>);
    if (browser === undefined) continue;
    const { id } = step as { id?: unknown };
    const { op, args } = browser;
    const bridge = (args as { bridge_id?: unknown }).bridge_id;
    const key = typeof bridge === 'string' ? CONFIG_REF.exec(bridge.trim())?.[1] : undefined;
    if (key === undefined || typeof recipe.variables?.[key] !== 'string') continue;
    found.push({ step_id: typeof id === 'string' ? id : '', op, key, target: args.target, args });
  }
  return found;
};

export const recipeBrowserSettings = (recipe: BrowserSettingsRecipe): BrowserSetting[] =>
  [...new Set(recipeBrowserSteps(recipe).map((step) => step.key))].sort().map((key) => ({ key }));
