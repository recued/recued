/** D-402 slice H3b (§4.2 item 3, §8 item 7) — the commands a browser step may send its Bridge, read before
 *  the run, so a Bridge too old for one is found before step 1 (`checkBrowsers`, `browser-routing.ts`)
 *  rather than at the step, after the steps before it ran.
 *
 *  Each command carries only the arguments that decide whether a Bridge runs it (`bridgeRunsCommand`): a
 *  page handle (which needs `describe`), `within` (the row check), `preserve_structure` (a collect by
 *  position). It lists what a step MAY send, so a command sent only in some runs is listed: a Bridge
 *  without it is asked to update before step 1, not stopped part way.
 *
 *  ⚠ One exception, on purpose: `navigation_guard`, which a click carries only when finding a link by its
 *  text recovered from a page that moved (`elementOf`, `dom-adapter.ts`). Listing it for every click named
 *  by text would refuse every older Bridge for a path most runs never take; that run still stops at the
 *  step, as before.
 *
 *  ⛔ KEPT HONEST BY A TEST, NOT BY READING: `d-402-browser-step-commands.test.ts` runs each kind of step
 *  through the real adapter against a Bridge that answers everything, and fails when the adapter sends a
 *  command a Bridge with only what this lists could not run. A new `send` in the batch loop must be added
 *  here, or that test goes red. */
import { browserCollectNeedsStructure, isHorizontalScrollDirection, type BridgeAction, type BrowserCollectSpec } from '@recued/contracts';

/** A command a step may send, with the arguments that decide whether a Bridge runs it. */
export interface BrowserCommand {
  readonly action: BridgeAction;
  readonly args: Readonly<Record<string, unknown>>;
}

const command = (action: BridgeAction, args: Record<string, unknown> = {}): BrowserCommand => ({ action, args });
/** On a page handle, as every command a batch sends to a tab is. */
const onPage = (action: BridgeAction, args: Record<string, unknown> = {}): BrowserCommand => command(action, { page: 'page', ...args });
const scrollArgs = (to: unknown) => isHorizontalScrollDirection(to) ? { to } : {};

/** A single operation's commands: by a page handle (and a read of the page after a write), or by a
 *  selector alone. */
const SINGLE: Readonly<Record<string, (args: Readonly<Record<string, unknown>>) => BrowserCommand[]>> = {
  'core.dom.read': () => [command('read_dom')],
  'core.dom.write': (args) => (args.page !== undefined || args.ref !== undefined ? [onPage('fill'), onPage('reread')] : [command('fill')]),
  'core.dom.click': (args) => (args.page !== undefined || args.ref !== undefined ? [onPage('click'), onPage('reread')] : [command('click')]),
  'core.dom.inspect': () => [onPage('inspect')],
  'core.dom.tabs': () => [command('list_tabs')],
  'core.dom.open': () => [command('open_tab')],
  'core.dom.wait': () => [onPage('wait_for_element'), onPage('reread')],
  'core.dom.table': () => [onPage('read_table')],
  'core.dom.screenshot': () => [onPage('screenshot_page')],
  'core.dom.scroll': (args) => [onPage('scroll', scrollArgs(args.to)), onPage('reread')],
  'core.dom.download': () => [onPage('download_file')],
  'core.dom.bridges': () => [],
};

/** The steps after which the batch reads the tab again, to say what the step changed. */
const READS_AFTER = new Set(['type', 'click', 'press', 'seek', 'submit', 'hover', 'drag', 'scroll', 'go', 'back', 'reload', 'close', 'upload']);

/** One step of an Act batch. Undefined for a kind this does not know: the batch refuses it itself. */
const actStepCommands = (step: Readonly<Record<string, unknown>>): BrowserCommand[] | undefined => {
  const commands: BrowserCommand[] = [];
  // A tab named by its address is found among the open tabs, or opened.
  if (step.url !== undefined) commands.push(command('list_tabs'), command('open_tab'));
  // An element named by its text is found in a read of the page first.
  const byText = step.text !== undefined;
  const within = step.within !== undefined ? { within: ['row'] } : {};
  switch (step.do) {
    case 'type': {
      if (step.secret !== undefined) commands.push(onPage('describe'));
      if (byText || step.secret !== undefined) commands.push(onPage('inspect'));
      if (step.pick !== undefined) {
        commands.push(onPage('pick'));
        if (step.submit === true) commands.push(onPage('submit'));
      } else commands.push(onPage(step.submit === true ? 'submit' : 'fill',
        step.delivery === 'paste' ? { ...within, delivery: 'paste' } : within));
      break;
    }
    case 'click':
      if (byText) commands.push(onPage('inspect'));
      commands.push(onPage('click', { ...within,
        ...(step.count === 2 ? { click_count: 2 } : {}),
        ...(typeof step.download_wait === 'number' ? { download_wait_ms: step.download_wait * 1000 } : {}) }));
      break;
    case 'press': case 'submit': case 'hover': case 'download':
      if (byText) commands.push(onPage('inspect'));
      commands.push(onPage(step.do === 'download' ? 'download_file' : step.do));
      break;
    case 'upload':
      if (byText) commands.push(onPage('inspect'));
      commands.push(onPage(step.files === undefined ? 'upload_file' : 'upload_files',
        step.delivery === 'drop' ? { delivery: 'drop' } : {}));
      break;
    case 'drag':
      commands.push(onPage('drag'));
      break;
    case 'seek':
      if (byText) commands.push(onPage('inspect'));
      commands.push(onPage('seek_media'));
      break;
    case 'wait':
      if (step.selector !== undefined) commands.push(onPage('wait_for_element'));
      if (step.url_includes !== undefined) commands.push(command('list_tabs'));
      // A wait for readiness reads the page; so does a plain wait of seconds, which a Bridge that can waits out in the page
      // (2026-11-20, `wait_change_ms`), and one that cannot answers at once.
      if (step.selector === undefined && step.url_includes === undefined) commands.push(onPage('reread'));
      break;
    case 'read': case 'ask':
      commands.push(onPage('inspect'));
      break;
    case 'collect': {
      const positional = (() => {
        try { return browserCollectNeedsStructure(step as unknown as BrowserCollectSpec); } catch { return true; }
      })();
      commands.push(onPage('reread', positional ? { preserve_structure: true } : {}));
      if (step.next !== undefined) commands.push(onPage('navigate'));
      break;
    }
    case 'table': commands.push(onPage('read_table')); break;
    case 'scroll':
      if (byText) commands.push(onPage('inspect'));
      commands.push(onPage('scroll', scrollArgs(step.to)));
      break;
    case 'go': commands.push(onPage('navigate')); break;
    case 'back': commands.push(onPage('go_back')); break;
    case 'reload': commands.push(onPage('reload_page')); break;
    case 'close': commands.push(onPage('close_tab')); break;
    case 'data': break;
    default: return undefined;
  }
  if (typeof step.do === 'string' && READS_AFTER.has(step.do)) commands.push(onPage('reread'));
  // A check the step waits for, or the part it reads once done.
  if (step.success_when !== undefined || step.then_read !== undefined) commands.push(onPage('wait_for_element'));
  return commands;
};

const keyOf = (one: BrowserCommand): string => `${one.action} ${JSON.stringify(Object.keys(one.args).sort())}`;

/** The commands a browser step may send, each once; undefined when the run alone knows them (its steps
 *  given by a setting or an earlier step, or a kind this does not know). */
export const browserStepCommands = (op: string, args: Readonly<Record<string, unknown>>): BrowserCommand[] | undefined => {
  let commands: BrowserCommand[] | undefined;
  if (op === 'core.dom.act') {
    if (!Array.isArray(args.steps)) return undefined;
    commands = [];
    for (const raw of args.steps) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const step = actStepCommands(raw as Record<string, unknown>);
      if (step === undefined) return undefined;
      commands.push(...step);
    }
  } else commands = SINGLE[op]?.(args);
  if (commands === undefined) return undefined;
  const seen = new Map<string, BrowserCommand>();
  for (const one of commands) if (!seen.has(keyOf(one))) seen.set(keyOf(one), one);
  return [...seen.values()];
};
