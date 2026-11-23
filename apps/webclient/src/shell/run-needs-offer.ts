/** What a failed step needed, offered where the run's result is shown (D-321 P2
 *  and C2): the run dialog, under its reason, and the result panel on a recipe's
 *  page and a pack's own view.
 *
 *  The server names the need (`ServerExecuteResponse.run_needs`, owner's runs
 *  only): a connection the service did not accept, a connection the step named
 *  that is not set up, or a program that is missing or would not run as it is.
 *  A step's own error says what failed ("exa-catalog returned 401
 *  Unauthorized"); this says what to do about it, and links there.
 *
 *  ── Where each link goes ────────────────────────────────────────────
 *  - Reconnect: the connection's own editor (`connectionsReviewAccessAddress`),
 *    where a key is replaced, and which starts a new sign-in for an OAuth one.
 *    When the run used several connections there, the pack's page instead.
 *  - Set up: the vendor's form opened for the pack's sign-in, as a run refused
 *    before it starts offers it (`connection-setup-offer.ts`).
 *  - A program: the pack's page, whose "What this pack needs" card says how to
 *    install it, where it was found, or which versions were tested.
 *
 *  ⛔ It links, it does not repair: each fix asks for a credential, a consent or
 *  a command on the owner's own machine, which the page it opens collects.
 *  🔑 One exception, by the owner's ruling (2026-11-08, "Turn it on" button): a program
 *  switched off for the owner is a switch, and the run dialog turns it on in one click
 *  (`ProgramSwitchSet`). The result panel still links to the pack. */

import type { RunBrowserNeed, RunNeed, RunProgramNeed, RunSwitchNeed, ServerExecuteResponse } from '@recued/contracts';
import type { RunModal } from '@recued/ui-shared';

import { connectionsLaneAddress, connectionsReviewAccessAddress } from '../connections/connections-navigation.js';
import { connectionSetupLead, connectionSetupLink } from './connection-setup-offer.js';
import { serializeShellRoute } from './route.js';

/** Marks the offer on a result panel. */
export const RUN_NEEDS_OFFER_ATTR = 'data-recued-run-needs-offer';
/** Which kind of need a link answers (`connection` / `program`). */
export const RUN_NEEDS_OFFER_KIND_ATTR = 'data-run-need';

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** One sentence per program problem. A program's name keeps its case (`rg`). */
const PROGRAM_SENTENCES: Readonly<Record<RunProgramNeed['problem'], (tool: string | undefined) => string>> = {
  not_found: (tool) => `${tool ?? 'A program this run uses'} is not installed on your server, or your server cannot find it.`,
  spawn_error: (tool) => `${tool ?? 'A program this run uses'} could not be started on your server.`,
  untested_version: (tool) => `The version of ${tool ?? 'a program this run uses'} on your server was not tested with this pack.`,
  broken: (tool) => `${tool ?? 'A program this run uses'} is installed on your server, but it did not start.`,
};

/** A program's sentence and its pack's page, for a run that stopped on it and
 *  (D-321 C2) for the run dialog before a run would. */
export const programNeedStep = (
  need: Pick<RunProgramNeed, 'problem' | 'tool' | 'pack_slug' | 'label'>,
): { lead: string; link: { text: string; href: string } | null } => ({
  lead: `${PROGRAM_SENTENCES[need.problem](need.tool)} Its pack’s page shows what to do.`,
  link: need.pack_slug === undefined
    ? null
    : { text: need.label !== undefined ? `Open ${need.label}` : 'Open its pack', href: serializeShellRoute('packs', need.pack_slug) },
});

/** D-346 follow-up — turns a program's switch on for the owner (`cli.reachability.set`). */
export type ProgramSwitchSet = (need: Pick<RunSwitchNeed, 'ingredient_id' | 'operation_id'>) => Promise<void>;

/** A program switched off for the owner: what happened, and its pack's page. */
const switchNeedStep = (need: RunSwitchNeed): { lead: string; link: { text: string; href: string } | null } => ({
  lead: `${need.label !== undefined ? `${need.label} runs a program on your server that` : 'A program this run uses'} `
    + 'is switched off for you, so the run stopped there.',
  link: need.pack_slug === undefined
    ? null
    : { text: need.label !== undefined ? `Open ${need.label}` : 'Open its pack', href: serializeShellRoute('packs', need.pack_slug) },
});

/** D-402 slice H3c — moves a dish's browser settings from one browser to another (`dishes.use_browser`). */
export type BrowserMove = (args: { dish_id: string; from: string; to: string }) => Promise<void>;

/** D-402 slice H3c (ruling 14) — a browser the recipe's settings name, gone or not connected. The run's
 *  reason already says which and what is missing; this says what else the owner can do, and opens the
 *  dish's settings, where the browser is chosen. */
const browserNeedStep = (need: RunBrowserNeed): { lead: string; link: { text: string; href: string } | null } => ({
  lead: need.problem === 'not_paired' ? 'Use another browser instead.' : 'Or use another browser instead.',
  link: need.dish_id === undefined ? null : { text: 'Choose a browser', href: serializeShellRoute('automation', 'dishes', need.dish_id) },
});

/** A need's sentence, and where its link goes (none when the server could not
 *  name the pack of a program). */
export const runNeedStep = (need: RunNeed): { lead: string; link: { text: string; href: string } | null } => {
  if (need.kind === 'program') return programNeedStep(need);
  if (need.kind === 'switch') return switchNeedStep(need);
  if (need.kind === 'browser') return browserNeedStep(need);
  const details = {
    slot: need.slot,
    ...(need.pack_slug !== undefined ? { pack_slug: need.pack_slug } : {}),
    ...(need.vendor !== undefined ? { vendor: need.vendor } : {}),
    ...(need.label !== undefined ? { label: need.label } : {}),
  };
  if (need.problem === 'set_up') return { lead: connectionSetupLead(details), link: connectionSetupLink(details) };
  const label = need.label ?? need.slot;
  return {
    lead: `${label} did not accept this run’s sign-in. Reconnect it, then run again.`,
    link: need.connection_name !== undefined
      ? { text: `Reconnect ${label}`, href: connectionsReviewAccessAddress(need.connection_name).hash }
      : need.pack_slug !== undefined
        ? { text: 'Open its pack', href: serializeShellRoute('packs', need.pack_slug) }
        : { text: 'Open Connections', href: connectionsLaneAddress('others').hash },
  };
};

const needsOf = (result: ServerExecuteResponse | null | undefined): readonly RunNeed[] =>
  Array.isArray(result?.run_needs) ? result.run_needs : [];

/** D-346 A — the programs a run refused before it started names
 *  (`program_not_installed`: a step that always runs launches a program the
 *  server cannot find), or null when this error is not that refusal.
 *
 *  ⛔ Read from `details.missing_programs`, never the message, as the pack offer
 *  reads its packs (`pack-install-offer.ts`). Each is the need a step that
 *  stopped on its program carries, so it is said and linked as that one is. */
export const programNeedsFromError = (err: unknown): RunProgramNeed[] | null => {
  if (err === null || typeof err !== 'object' || (err as { code?: unknown }).code !== 'program_not_installed') return null;
  const details = (err as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') return null;
  const listed = (details as { missing_programs?: unknown }).missing_programs;
  if (!Array.isArray(listed)) return null;
  const needs = listed.filter((need): need is RunProgramNeed => need !== null && typeof need === 'object'
    && (need as { kind?: unknown }).kind === 'program'
    && Object.prototype.hasOwnProperty.call(PROGRAM_SENTENCES, (need as { problem?: unknown }).problem as string));
  return needs.length > 0 ? needs : null;
};

/** D-402 slice H3c — the one browser to move to, in one click: only when the run names exactly one
 *  browser it could not use, the server named the only other one connected that the run does not already
 *  use, and the dish is known. ⛔ Never two at once: two missing browsers moved to the one connected would
 *  make a recipe that reads in one and types in the other do both in one. Those are chosen in the dish's
 *  settings. */
const browserToMoveTo = (needs: readonly RunNeed[]): (RunBrowserNeed & { dish_id: string; instead: { browser_id: string; name: string } }) | undefined => {
  const browsers = needs.filter((need): need is RunBrowserNeed => need.kind === 'browser');
  if (new Set(browsers.map((need) => need.browser_id)).size !== 1) return undefined;
  const offer = browsers.find((need) => need.instead !== undefined && need.dish_id !== undefined);
  return offer as (RunBrowserNeed & { dish_id: string; instead: { browser_id: string; name: string } }) | undefined;
};

/** The run dialog's next step for these needs, or null when there are none. With
 *  `turnOn`, a program switched off for the owner is turned on from the dialog ("Turn it
 *  on"), every one the run named at once. With `move` (D-402 slice H3c), a browser no longer
 *  paired or not connected is replaced by the only other one connected, "Use “Work” instead". */
export const runNeedsStep = (needs: readonly RunNeed[], turnOn?: ProgramSwitchSet, move?: BrowserMove): RunModal.RunModalNextStep | null => {
  const steps = needs.map(runNeedStep);
  if (steps.length === 0) return null;
  const switches = needs.filter((need): need is RunSwitchNeed => need.kind === 'switch');
  const moveTo = move !== undefined && switches.length === 0 ? browserToMoveTo(needs) : undefined;
  return {
    lead: [...new Set(steps.map((step) => step.lead))].join(' '),
    links: steps.flatMap((step) => (step.link === null ? [] : [step.link]))
      .filter((link, index, all) => all.findIndex((other) => other.href === link.href) === index),
    ...(turnOn !== undefined && switches.length > 0
      ? {
          action: {
            text: switches.length === 1 ? 'Turn it on' : 'Turn them on',
            run: async () => {
              for (const need of switches) await turnOn({ ingredient_id: need.ingredient_id, operation_id: need.operation_id });
            },
            // Said in place of what was off, so it names what is on.
            done: `${switches.length === 1
              ? `${switches[0]!.label !== undefined ? `${switches[0]!.label}'s program` : 'Its program'} is`
              : 'Their programs are'} on now. Run it again.`,
          },
        }
      : moveTo !== undefined
      ? {
          action: {
            text: `Use “${moveTo.instead.name}” instead`,
            run: async () => {
              await move!({ dish_id: moveTo.dish_id, from: moveTo.browser_id, to: moveTo.instead.browser_id });
            },
            done: `It acts in “${moveTo.instead.name}” now. Run it again.`,
          },
        }
      : {}),
  };
};

/** The run dialog's next step for a run that returned errors, or null. */
export const runNeedsNextStep = (result: ServerExecuteResponse, turnOn?: ProgramSwitchSet, move?: BrowserMove): RunModal.RunModalNextStep | null =>
  runNeedsStep(needsOf(result), turnOn, move);

/** The offer on a result panel: a sentence and a link for each need. It wears
 *  the install offer's classes, which both of its hosts inject. */
export const renderRunNeedsOffer = (result: ServerExecuteResponse | null | undefined): string =>
  renderRunNeedList(needsOf(result));

/** The same offer for needs read elsewhere: a run refused before it started
 *  (D-346 A, `programNeedsFromError`). */
export const renderRunNeedList = (needs: readonly RunNeed[]): string => {
  if (needs.length === 0) return '';
  const rows = needs.map((need) => {
    const step = runNeedStep(need);
    return `<p class="pack-offer-lead">${e(step.lead)}</p>`
      + (step.link === null ? '' : `<div class="pack-offer-row"><a class="recipes-button pack-offer-link"`
        + ` href="${e(step.link.href)}" ${RUN_NEEDS_OFFER_KIND_ATTR}="${e(need.kind)}">${e(step.link.text)}</a></div>`);
  }).join('');
  return `<div class="pack-offer" ${RUN_NEEDS_OFFER_ATTR} role="group" aria-label="What this run needed">${rows}</div>`;
};
