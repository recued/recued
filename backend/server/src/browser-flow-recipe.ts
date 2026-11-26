/** D-335 slice W4 — a kept browser flow made into a recipe, without a model.
 *
 *  Every fact a recipe needs is in the flow: the page it began on, each element by a selector that
 *  finds it alone, and what was typed. So the draft is built, not authored: the page is found among
 *  the open tabs by its address (and opened, which asks, when none shows it), then one Act on a web
 *  page sequence does the steps by their selectors, each typed text a setting whose default is what
 *  was typed. A field for a password, a sign-in code or a card kept nothing: its setting has no
 *  default, so the recipe asks for it.
 *
 *  ⛔ DRAFTS, NEVER SAVES — as the case draft (`chat.execution.draft_recipe`): it opens in Kitchen
 *  for the owner to read, change and save. An element no selector found alone keeps its place as a
 *  step with a selector to fill in, and the issues say which. */

import type { ExecutionBrowserFlowStep, RecipeDefinition } from '@recued/contracts';

/** Every site the Bridge may use, as the toolkit's recipes name it. */
const ANY_SITE = '*://*/*';
/** What a step whose element no selector found alone holds, for the owner to replace in Kitchen. */
export const BROWSER_FLOW_SELECTOR_TO_FILL = 'SELECTOR-TO-FILL';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** The page's address without its query or fragment: what a tab showing it again holds. */
const pageAddress = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  || 'page';
const quoted = (text: string): string => `“${text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text}”`;
const verb: Record<ExecutionBrowserFlowStep['do'], string> = {
  type: 'type into', pick: 'pick in', click: 'click', press: 'press a key in', seek: 'seek within', submit: 'send the form of',
};
const stepVerb = (step: ExecutionBrowserFlowStep): string =>
  step.do === 'click' && step.count === 2 ? 'double-click'
    : step.do === 'type' && step.delivery === 'paste' ? 'paste into' : verb[step.do];

export interface BrowserFlowRecipeDraft {
  recipe: RecipeDefinition;
  /** What the owner must look at before it runs: a step with no selector, a secret to type. */
  issues: string[];
}

/** The recipe for a flow, its id unique to the flow (`id` is the flow's). */
export const recipeFromBrowserFlow = (flow: { flow_id: string; steps: readonly ExecutionBrowserFlowStep[] }): BrowserFlowRecipeDraft => {
  const issues: string[] = [];
  const first = flow.steps[0];
  if (first === undefined) throw new Error('A browser flow with no steps makes no recipe');
  const site = hostOf(first.url);
  const variables: Record<string, unknown> = {};
  let texts = 0;
  const actSteps = flow.steps.map((step, i) => {
    const n = i + 1;
    const what = `the ${step.element.role} ${quoted(step.element.label)}`;
    const selector = step.element.selector ?? BROWSER_FLOW_SELECTOR_TO_FILL;
    if (step.element.selector === undefined) {
      issues.push(`Step ${String(n)} (${stepVerb(step)} ${what}) has no selector that finds it alone: replace `
        + `${BROWSER_FLOW_SELECTOR_TO_FILL} with one in Kitchen.`);
    }
    // A typed text is a setting, named by the field it went into.
    let value: string | undefined;
    if (step.do === 'type' || step.do === 'pick' || (step.do === 'submit' && (step.value !== undefined || step.secret === true))) {
      texts += 1;
      const key = `text_${String(texts)}`;
      variables[key] = {
        label: step.element.label === '' ? `Text ${String(texts)}` : step.element.label,
        type: 'string',
        help: step.secret === true
          ? `What to type into ${what}. It is for a password, a sign-in code or a card, so what was typed was not kept: `
            + 'type it each time.'
          : `What to type into ${what} on ${hostOf(step.url)}.`,
        ...(step.secret === true ? {} : { default: step.value ?? '' }),
      };
      if (step.secret === true) issues.push(`Step ${String(n)} types into ${what}: what was typed was not kept, so the recipe asks for it.`);
      value = `{{config.${key}}}`;
    }
    if (step.do === 'seek') return { do: 'seek', selector, at_seconds: step.at_seconds };
    return step.do === 'click' ? { do: 'click', selector, ...(step.count === 2 ? { count: 2 } : {}) }
      : step.do === 'press' ? { do: 'press', selector, key: step.key ?? 'Enter' }
        : step.do === 'submit' ? (value !== undefined ? { do: 'type', selector, value, submit: true } : { do: 'submit', selector })
          : step.do === 'pick' ? { do: 'type', selector, value: value!, pick: step.pick ?? '' }
            : { do: 'type', selector, value: value!, ...(step.delivery === 'paste' ? { delivery: 'paste' } : {}) };
  });
  const summary = flow.steps.slice(0, 3).map((step) => `${stepVerb(step)} ${quoted(step.element.label)}`).join(', ');
  const recipe = {
    recipe_id: `browser-flow-${slug(site)}-${flow.flow_id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`,
    version: 1,
    ttl: 0,
    metadata: {
      name: `On ${site}: ${summary}${flow.steps.length > 3 ? '…' : ''}`.slice(0, 100),
      description: `Does in your browser what your AI did on ${site} and you kept: ${String(flow.steps.length)} `
        + `${flow.steps.length === 1 ? 'step' : 'steps'} on the page ${pageAddress(first.url)}, through the Browser Bridge, `
        + 'with no AI. It finds the page among your open tabs, or opens it.',
      author: 'you',
      supported_platforms: [],
      tags: ['browser', 'web', 'browser-flow'],
    },
    variables,
    steps: [
      { id: 'tabs', op: 'core.dom.tabs', args: { target: ANY_SITE } },
      { id: 'tab', transform: 'find', array: '{{step.tabs.tabs}}', field: 'url', operator: 'contains', value: pageAddress(first.url) },
      { id: 'opened', op: 'core.dom.open', args: { target: ANY_SITE, address: first.url }, skip_when: '{{step.tab}} is_not_null' },
      { id: 'page', transform: 'coalesce', values: ['{{step.tab.page}}', '{{step.opened.page}}'] },
      { id: 'act', op: 'core.dom.act', args: { target: ANY_SITE, page: '{{step.page}}', steps: actSteps } },
    ],
    output: { render: [{ type: 'json', source: 'step.act', label: 'Done' }] },
  } as unknown as RecipeDefinition;
  return { recipe, issues };
};
