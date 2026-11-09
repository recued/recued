/** D-321 slice 3 — the pack page's Programs block (D-321 § 3.5):
 *  the programs a pack runs on the owner's server, whether each is ready, the
 *  versions the pack was tested with, what a run does outside them, and how to
 *  install one. Backed by `packs.tool_status` and the owner's per-tool choice
 *  (`collection.operation.{upsert,delete}OwnerToolVersion`).
 *
 *  - The state and the install commands come from the server: only it can run
 *    the version probe, and only it knows its own system.
 *  - Refuse / Warn sits here, beside the state it governs, because the refusal
 *    sends the owner to "its pack's page in Packs" and this is what that page
 *    opens on.
 *  - Recued never runs an install command (D-170): the block shows it with a
 *    Copy button.
 *
 *  Same controller shape as the Connections block (`pack-connections-controls.ts`):
 *  injected callers, a host re-render hook, a sync `renderForPack` over cached
 *  state that loads on first sight. */

import {
  describeTestedRange,
  type CliVersionOutside,
  type OwnerToolPathView,
  type OwnerToolVersionView,
  type PackListEntry,
  type PackToolStatus,
  type PacksToolStatusRequest,
  type PacksToolStatusResult,
} from '@recued/contracts';

import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

/** The three calls. The two writes are optional: without them the setting is
 *  shown and cannot be changed. */
export interface PackProgramsCallers {
  status: (args: PacksToolStatusRequest) => Promise<PacksToolStatusResult>;
  setOutside?: (args: { ingredient_id: string; outside: CliVersionOutside }) => Promise<OwnerToolVersionView>;
  clearOutside?: (args: { ingredient_id: string }) => Promise<{ deleted: boolean }>;
  /** D-321 — where the owner sets a program (`collection.operation.upsertOwnerToolPath`).
   *  Absent: no location can be set here. */
  setPath?: (args: { ingredient_id: string; path: string }) => Promise<OwnerToolPathView>;
  clearPath?: (args: { ingredient_id: string }) => Promise<{ deleted: boolean }>;
}

export const PACK_PROGRAMS_ATTR = 'data-recued-pack-programs';
/** On each program's row: its catalog. */
export const PACK_PROGRAMS_ROW_ATTR = 'data-recued-pack-program';
/** On each row: the tool's state. */
export const PACK_PROGRAMS_STATE_ATTR = 'data-recued-pack-program-state';
/** On the Refuse / Warn buttons: the setting each picks. */
export const PACK_PROGRAMS_OUTSIDE_ATTR = 'data-recued-pack-program-outside';
/** On the other buttons: `check-again` / `use-default` / `copy`. */
export const PACK_PROGRAMS_ACTION_ATTR = 'data-recued-pack-programs-action';
/** On each install command. */
export const PACK_PROGRAMS_INSTALL_ATTR = 'data-recued-pack-program-install';
/** D-321 — on the block for a program installed outside the server's PATH: the
 *  file found. */
export const PACK_PROGRAMS_FOUND_AT_ATTR = 'data-recued-pack-program-found-at';
/** On the command that gives the server a terminal's PATH. */
export const PACK_PROGRAMS_REPAIR_ATTR = 'data-recued-pack-program-repair';
/** D-321 — on the line naming the location the owner set: that path. */
export const PACK_PROGRAMS_LOCATION_ATTR = 'data-recued-pack-program-location';
/** D-346 — on that line when the location was set on the pack a Kitchen copy
 *  copies: that pack's catalog. */
export const PACK_PROGRAMS_LOCATION_FROM_ATTR = 'data-recued-pack-program-location-from';
/** On the field where a location is typed: the program's catalog. */
export const PACK_PROGRAMS_LOCATION_INPUT_ATTR = 'data-recued-pack-program-location-input';
export const PACK_PROGRAMS_ERROR_ATTR = 'data-recued-pack-programs-error';

/** A program's name as the owner knows it: the last part of the path the pack
 *  launches (`opencode`; Defender's `C:\…\MpCmdRun.exe` reads `MpCmdRun.exe`). */
export const programDisplayName = (binary: string): string => {
  const parts = binary.split(/[\\/]/u).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? binary;
};

/** Marks on each Programs control: the pack, program and command it acts for.
 *  Every action re-renders the whole pack page, which drops focus to the page;
 *  the page reads these to put focus back on the same control. */
export const PACK_PROGRAMS_FOR_PACK_ATTR = 'data-recued-pack-programs-pack';
export const PACK_PROGRAMS_FOR_CATALOG_ATTR = 'data-recued-pack-programs-catalog';
export const PACK_PROGRAMS_FOR_COMMAND_ATTR = 'data-recued-pack-programs-command';

const markFor = (control: HTMLElement, pack: string, catalog?: string, command?: string): void => {
  control.setAttribute(PACK_PROGRAMS_FOR_PACK_ATTR, pack);
  if (catalog !== undefined) control.setAttribute(PACK_PROGRAMS_FOR_CATALOG_ATTR, catalog);
  if (command !== undefined) control.setAttribute(PACK_PROGRAMS_FOR_COMMAND_ATTR, command);
};

/** Which Programs control had focus, read off its own marks. */
export interface PackProgramsFocus {
  attr: string;
  value: string;
  pack: string;
  catalog: string | null;
  command: string | null;
}

export const packProgramsFocusOf = (element: HTMLElement | null): PackProgramsFocus | null => {
  if (element === null || typeof element.getAttribute !== 'function') return null;
  const pack = element.getAttribute(PACK_PROGRAMS_FOR_PACK_ATTR);
  if (pack === null) return null;
  for (const attr of [PACK_PROGRAMS_OUTSIDE_ATTR, PACK_PROGRAMS_ACTION_ATTR]) {
    const value = element.getAttribute(attr);
    if (value !== null) {
      return {
        attr,
        value,
        pack,
        catalog: element.getAttribute(PACK_PROGRAMS_FOR_CATALOG_ATTR),
        command: element.getAttribute(PACK_PROGRAMS_FOR_COMMAND_ATTR),
      };
    }
  }
  return null;
};

/** Where focus goes back to, in order: the same control; when it is gone ("Use
 *  the pack's default" goes once used), the option now chosen for the same
 *  program; else the pack's "Check again". */
export const packProgramsFocusTargets = (
  focus: PackProgramsFocus,
): Array<(element: HTMLElement) => boolean> => {
  const ofPack = (element: HTMLElement): boolean =>
    element.tagName === 'BUTTON' && element.getAttribute?.(PACK_PROGRAMS_FOR_PACK_ATTR) === focus.pack;
  const ofProgram = (element: HTMLElement): boolean =>
    element.getAttribute(PACK_PROGRAMS_FOR_CATALOG_ATTR) === focus.catalog;
  return [
    (element) => ofPack(element) && ofProgram(element)
      && element.getAttribute(focus.attr) === focus.value
      && element.getAttribute(PACK_PROGRAMS_FOR_COMMAND_ATTR) === focus.command,
    (element) => ofPack(element) && ofProgram(element)
      && element.hasAttribute(PACK_PROGRAMS_OUTSIDE_ATTR)
      && element.getAttribute('aria-pressed') === 'true',
    (element) => ofPack(element) && element.getAttribute(PACK_PROGRAMS_ACTION_ATTR) === 'check-again',
  ];
};

const OUTSIDE_LABEL: Record<CliVersionOutside, string> = { refuse: 'Refuse', warn: 'Warn' };

const COPY = {
  heading: 'Programs',
  intro: 'The programs this pack runs on your server. Recued does not install them for you.',
  intro_before_install: 'The programs this pack runs, checked on your server before you install it. Recued does not install them for you.',
  loading: 'Checking the programs…',
  load_failed: (message: string) => `Could not check this pack's programs: ${message}`,
  retry: 'Try again',
  check_again: 'Check again',
  checking: 'Checking…',
  action_failed: (message: string) => `That did not work: ${message}`,
  state: {
    ready_tested: (version: string) => `${version} · tested`,
    ready: 'Installed',
    missing: 'Not installed',
    outside_path: "Not on the server's PATH",
    broken: 'Installed, but does not start',
    untested: (version: string) => `${version} · not tested`,
    unreadable: 'Version unknown',
  },
  tested: (range: string) => `This pack was tested with ${range}.`,
  refused: 'Its actions are refused until you install a tested version or choose Warn.',
  warned: 'Its actions still run.',
  missing_note: 'Its actions fail until you install it.',
  outside_note: 'Its actions fail until the server can find it.',
  found_at: (path: string, folder: string) => `Installed at ${path}, but the server doesn't look in ${folder}.`,
  repair_label: "Recued starts by itself, so it doesn't have your terminal's PATH. To give it yours, run this in a terminal where the program works:",
  no_repair: (folder: string) =>
    `Start Recued from a terminal where the program works, or add ${folder} to the PATH it starts with.`,
  broken_note: 'Its actions are refused until it starts.',
  setting_label: 'When the installed version is not tested:',
  pack_default: (outside: CliVersionOutside) => `The pack's default is ${OUTSIDE_LABEL[outside]}.`,
  use_default: "Use the pack's default",
  stale: (outside: CliVersionOutside) =>
    `You chose ${OUTSIDE_LABEL[outside]} for this pack's earlier versions. The pack's default applies until you choose again.`,
  install_label: 'Install with:',
  copy: 'Copy',
  copy_label: (command: string) => `Copy: ${command}`,
  copied: 'Copied',
  copy_failed: (message: string) => `Could not copy: ${message}`,
  docs: 'Install instructions',
  // D-321 — where the program is.
  use_found: (path: string) => `Use ${path}`,
  use_found_label: (path: string) => `Run this program from ${path}`,
  located: (path: string) => `Runs ${path}, the location you set.`,
  /** D-346 — a Kitchen copy running the location set for its original. */
  located_from_original: (path: string) => `Runs ${path}, the location you set for the pack this copies. Set one here to change it for this copy.`,
  use_path: "Use the server's PATH",
  set_location: 'Set where it is',
  location_label: (name: string) => `Where ${name} is, as a full path`,
  save_location: 'Use this file',
} as const;

/** A program's state in a few words: "1.18.35 · tested", "Not installed". The
 *  cli grant dialog shows the same words for a pack it just installed. */
export const programStateText = (tool: PackToolStatus): string => {
  switch (tool.state) {
    case 'ready':
      return tool.version !== undefined && tool.tested !== undefined
        ? COPY.state.ready_tested(tool.version)
        : COPY.state.ready;
    case 'missing': return tool.found_at !== undefined ? COPY.state.outside_path : COPY.state.missing;
    case 'broken': return COPY.state.broken;
    case 'untested': return COPY.state.untested(tool.version ?? '?');
    case 'unreadable': return COPY.state.unreadable;
  }
};

/** Whether the program stops its pack's actions: one that is missing or does
 *  not start, or a version outside the range under Refuse. The list badge, the
 *  Programs block and the grant dialog all show red for exactly these. */
export const programStopsRuns = (tool: PackToolStatus): boolean =>
  tool.state === 'broken' || tool.state === 'missing'
  || ((tool.state === 'untested' || tool.state === 'unreadable') && tool.outside !== 'warn');

/** What the state means for a run, in one sentence; null when it runs. */
export const programConsequence = (tool: PackToolStatus): string | null => {
  if (tool.state === 'missing') return tool.found_at !== undefined ? COPY.outside_note : COPY.missing_note;
  if (tool.state === 'broken') return COPY.broken_note;
  if (tool.state === 'untested' || tool.state === 'unreadable') {
    return tool.outside === 'warn' ? COPY.warned : COPY.refused;
  }
  return null;
};

/** The folder a found program sits in. Only POSIX servers report one. */
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 1));

/** D-321 — where a program the server cannot find is installed, in one
 *  sentence; null when it was not found anywhere. The grant dialog shows the
 *  same words. */
export const programFoundAtText = (tool: PackToolStatus): string | null =>
  tool.found_at === undefined ? null : COPY.found_at(tool.found_at, folderOf(tool.found_at));

/** What gives the server that folder: the repair command's lead-in when the
 *  server offers one, else what the owner does themselves. */
export const programRepairText = (tool: PackToolStatus): string | null => {
  if (tool.found_at === undefined) return null;
  return tool.repair !== undefined ? COPY.repair_label : COPY.no_repair(folderOf(tool.found_at));
};

export interface PackProgramsControllerOptions {
  document: Document;
  /** Absent ⇒ the block is not shown (the server does not offer the call). */
  callers?: PackProgramsCallers;
  /** Host re-render hook, fired after every state change. */
  onChange: () => void;
  /** Writes `text` to the clipboard. Default: `navigator.clipboard`. */
  copyText?: (text: string) => Promise<void>;
}

export interface PackProgramsController {
  readonly enabled: boolean;
  /** Forget what was loaded, so the next render checks again (the list changed). */
  refresh(): void;
  /** The block for one pack: null while disabled, on a server without the call,
   *  or once loaded when the pack runs no program. */
  renderForPack(pack: PackListEntry): HTMLElement | null;
  /** D-321 C1 — the pack's programs as last read (the install panel lists them),
   *  or null before a read answers. */
  toolsFor(packSlug: string): readonly PackToolStatus[] | null;
  /** Test seam: resolves once nothing is loading or writing. */
  whenSettled(): Promise<void>;
  dispose(): void;
}

type PackState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'unsupported' }
  /** `installed: false` — D-321 C1: the pack is not installed, and these are the
   *  programs it would run, checked before install. Nothing is stored for them. */
  | { status: 'ready'; tools: PackToolStatus[]; installed: boolean };

const defaultCopy = async (text: string): Promise<void> => {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
    .navigator?.clipboard;
  if (clipboard?.writeText === undefined) throw new Error('This browser does not allow copying here.');
  await clipboard.writeText(text);
};

export const createPackProgramsController = (
  opts: PackProgramsControllerOptions,
): PackProgramsController => {
  const doc = opts.document;
  const callers = opts.callers;
  const enabled = callers !== undefined;
  const copyText = opts.copyText ?? defaultCopy;
  const states = new Map<string, PackState>();
  /** Packs with a check or a write in flight. */
  const busy = new Set<string>();
  /** The last write's failure, per pack, until the next action. */
  const writeErrors = new Map<string, string>();
  /** The command most recently copied, so its button can say so. */
  let copied: string | null = null;
  /** Why the last copy failed, until the next copy. */
  let copyError: string | null = null;
  /** D-321 — a location being typed, per program, and which fields are open:
   *  every action re-renders the block, which must not lose either. */
  const drafts = new Map<string, string>();
  const openLocate = new Set<string>();
  /** The newest status read per pack: an older one that lands later is dropped,
   *  so it can neither put back an earlier answer nor end another's busy. */
  let reads = 0;
  const newestRead = new Map<string, number>();
  let inFlight = new Set<Promise<unknown>>();
  let disposed = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  const changed = (): void => {
    if (!disposed) opts.onChange();
  };
  const readyOf = (result: PacksToolStatusResult, packSlug: string): PackState => {
    const entry = result.packs.find((candidate) => candidate.slug === packSlug);
    return { status: 'ready', tools: entry?.tools ?? [], installed: entry?.installed !== false };
  };

  /** Read the pack's programs: `first` shows "Checking…" until the answer; a
   *  `reload` (after a write) and a `recheck` ("Check again") keep what is shown,
   *  and a recheck asks the server to probe again. */
  const load = (packSlug: string, mode: 'first' | 'reload' | 'recheck' = 'first'): void => {
    if (callers === undefined) return;
    if (mode === 'first') states.set(packSlug, { status: 'loading' });
    const mine = ++reads;
    newestRead.set(packSlug, mine);
    busy.add(packSlug);
    void track(callers.status({ pack_slug: packSlug, ...(mode === 'recheck' ? { recheck: true } : {}) }).then(
      (result) => {
        if (newestRead.get(packSlug) !== mine) return;
        busy.delete(packSlug);
        states.set(packSlug, readyOf(result, packSlug));
        changed();
      },
      (error: unknown) => {
        if (newestRead.get(packSlug) !== mine) return;
        busy.delete(packSlug);
        if (mode !== 'first' && states.get(packSlug)?.status === 'ready') {
          writeErrors.set(packSlug, humanizeRpcError(error));
        } else {
          states.set(
            packSlug,
            classifyRpcError(error).code === 'unknown_method'
              ? { status: 'unsupported' }
              : { status: 'error', message: humanizeRpcError(error) },
          );
        }
        changed();
      },
    ));
  };

  /** A Refuse / Warn write, or going back to the pack's default; then the
   *  server's status again, so the block shows what it now answers. */
  const write = (packSlug: string, call: () => Promise<unknown>): void => {
    if (busy.has(packSlug)) return;
    busy.add(packSlug);
    writeErrors.delete(packSlug);
    changed();
    void track(call().then(
      () => {
        busy.delete(packSlug);
        load(packSlug, 'reload');
        changed();
      },
      (error: unknown) => {
        busy.delete(packSlug);
        writeErrors.set(packSlug, humanizeRpcError(error));
        changed();
      },
    ));
  };

  const el = <K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  };

  const button = (
    parent: HTMLElement,
    label: string,
    primary: boolean,
    disabled: boolean,
    onClick: () => void,
  ): HTMLButtonElement => {
    const b = el(parent, 'button', primary ? 'rx-btn rx-btn-primary' : 'rx-btn rx-btn-secondary', label);
    b.type = 'button';
    if (disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', () => {
      if (!disabled) onClick();
    });
    return b;
  };

  const renderSetting = (parent: HTMLElement, packSlug: string, tool: PackToolStatus): void => {
    if (tool.tested === undefined || tool.outside === undefined || tool.pack_outside === undefined) return;
    const block = el(parent, 'div', 'pp-setting');
    el(block, 'span', 'pp-setting-label', COPY.setting_label);
    const choices = el(block, 'span', 'pp-choices');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', COPY.setting_label);
    const canWrite = callers?.setOutside !== undefined;
    const isBusy = busy.has(packSlug);
    for (const outside of ['refuse', 'warn'] as const) {
      const chosen = tool.outside === outside;
      const b = button(choices, OUTSIDE_LABEL[outside], chosen, !canWrite || isBusy, () => {
        if (chosen) return;
        write(packSlug, () => callers!.setOutside!({ ingredient_id: tool.catalog, outside }));
      });
      b.setAttribute(PACK_PROGRAMS_OUTSIDE_ATTR, outside);
      b.setAttribute('aria-pressed', chosen ? 'true' : 'false');
      markFor(b, packSlug, tool.catalog);
    }
    el(block, 'span', 'pp-note', COPY.pack_default(tool.pack_outside));
    // Shown for any choice the owner stored, a stale one too: pressing the
    // option already shown does nothing, so this is how the note below clears.
    if (tool.owner_outside !== undefined && callers?.clearOutside !== undefined) {
      const reset = button(block, COPY.use_default, false, isBusy, () => {
        write(packSlug, () => callers.clearOutside!({ ingredient_id: tool.catalog }));
      });
      reset.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'use-default');
      markFor(reset, packSlug, tool.catalog);
    }
    if (tool.stale_owner_choice === true && tool.owner_outside !== undefined) {
      el(parent, 'p', 'pp-note', COPY.stale(tool.owner_outside));
    }
  };

  /** One command to copy: shown, never run (D-170). `attr` marks the code
   *  element: an install command or the PATH repair. */
  const commandRow = (list: HTMLElement, packSlug: string, tool: PackToolStatus, command: string, attr: string): void => {
    const row = el(list, 'li', 'pp-install-row');
    const code = el(row, 'code', 'pp-command', command);
    code.setAttribute(attr, command);
    const copy = button(row, copied === command ? COPY.copied : COPY.copy, false, false, () => {
      void copyText(command).then(
        () => {
          copied = command;
          copyError = null;
          changed();
        },
        (error: unknown) => {
          copied = null;
          copyError = error instanceof Error ? error.message : String(error);
          changed();
        },
      );
    });
    copy.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'copy');
    copy.setAttribute('aria-label', COPY.copy_label(command));
    markFor(copy, packSlug, tool.catalog, command);
  };

  const copyErrorLine = (block: HTMLElement): void => {
    if (copyError === null) return;
    const failed = el(block, 'p', 'pp-error', COPY.copy_failed(copyError));
    failed.setAttribute(PACK_PROGRAMS_ERROR_ATTR, '');
    failed.setAttribute('role', 'alert');
  };

  /** D-321 — installed, but outside the server's PATH: where it is and how the
   *  owner gives the server that folder, instead of install commands for a
   *  program that is already there. */
  const renderOutsidePath = (parent: HTMLElement, packSlug: string, tool: PackToolStatus, readOnly = false): void => {
    const block = el(parent, 'div', 'pp-install');
    block.setAttribute(PACK_PROGRAMS_FOUND_AT_ATTR, tool.found_at ?? '');
    el(block, 'p', 'pp-note', programFoundAtText(tool) ?? '');
    const found = tool.found_at;
    const setPath = readOnly ? undefined : callers?.setPath;
    if (found !== undefined && setPath !== undefined) {
      // One click: this program runs from the file the server found.
      const use = button(block, COPY.use_found(found), true, busy.has(packSlug), () => {
        write(packSlug, () => setPath({ ingredient_id: tool.catalog, path: found }));
      });
      use.className += ' pp-use-found';
      use.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'use-found');
      use.setAttribute('aria-label', COPY.use_found_label(found));
      markFor(use, packSlug, tool.catalog);
    }
    el(block, 'p', 'pp-install-label', programRepairText(tool) ?? '');
    if (tool.repair === undefined) return;
    const list = el(block, 'ul', 'pp-install-list');
    commandRow(list, packSlug, tool, tool.repair, PACK_PROGRAMS_REPAIR_ATTR);
    copyErrorLine(block);
  };

  /** D-321 — the location the owner set, while it applies, and the way back. */
  const renderLocation = (parent: HTMLElement, packSlug: string, tool: PackToolStatus): void => {
    const path = tool.owner_path;
    if (path === undefined) return;
    const line = el(parent, 'div', 'pp-location');
    line.setAttribute(PACK_PROGRAMS_LOCATION_ATTR, path);
    // D-346 — a copy running its original's location: clearing a row the copy
    // does not have would change nothing, so the way back is not offered here.
    const fromOriginal = tool.owner_path_from !== undefined;
    el(line, 'span', 'pp-note', fromOriginal ? COPY.located_from_original(path) : COPY.located(path));
    if (fromOriginal) line.setAttribute(PACK_PROGRAMS_LOCATION_FROM_ATTR, tool.owner_path_from!);
    const clearPath = callers?.clearPath;
    if (clearPath === undefined || fromOriginal) return;
    const back = button(line, COPY.use_path, false, busy.has(packSlug), () => {
      write(packSlug, () => clearPath({ ingredient_id: tool.catalog }));
    });
    back.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'use-path');
    markFor(back, packSlug, tool.catalog);
  };

  /** D-321 — typing where a program is: one the server did not find, or a
   *  location to change. The server checks the file before it keeps it, and
   *  says why when it does not. What is typed survives the re-renders. */
  const renderSetLocation = (parent: HTMLElement, packSlug: string, tool: PackToolStatus): void => {
    const setPath = callers?.setPath;
    if (setPath === undefined || (tool.state === 'ready' && tool.owner_path === undefined)) return;
    const details = el(parent, 'details', 'pp-locate');
    if (openLocate.has(tool.catalog)) details.setAttribute('open', '');
    details.addEventListener('toggle', () => {
      if ((details as HTMLDetailsElement).open) openLocate.add(tool.catalog);
      else openLocate.delete(tool.catalog);
    });
    el(details, 'summary', 'pp-locate-summary', COPY.set_location);
    const form = el(details, 'div', 'pp-locate-row');
    const input = el(form, 'input', 'pp-locate-input');
    input.type = 'text';
    input.setAttribute(PACK_PROGRAMS_LOCATION_INPUT_ATTR, tool.catalog);
    input.setAttribute('aria-label', COPY.location_label(programDisplayName(tool.binary)));
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.placeholder = `/full/path/to/${programDisplayName(tool.binary)}`;
    input.value = drafts.get(tool.catalog) ?? tool.owner_path ?? '';
    input.addEventListener('input', () => { drafts.set(tool.catalog, input.value); });
    const save = button(form, COPY.save_location, false, busy.has(packSlug), () => {
      const path = (drafts.get(tool.catalog) ?? input.value).trim();
      if (path.length === 0) return;
      write(packSlug, async () => {
        await setPath({ ingredient_id: tool.catalog, path });
        drafts.delete(tool.catalog);
        openLocate.delete(tool.catalog);
      });
    });
    save.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'save-location');
    markFor(save, packSlug, tool.catalog);
  };

  const renderInstall = (parent: HTMLElement, packSlug: string, tool: PackToolStatus, readOnly = false): void => {
    if (tool.state === 'ready') return;
    if (tool.found_at !== undefined) {
      renderOutsidePath(parent, packSlug, tool, readOnly);
      return;
    }
    if (tool.install.length === 0 && tool.docs.length === 0) return;
    const block = el(parent, 'div', 'pp-install');
    if (tool.install.length > 0) {
      el(block, 'p', 'pp-install-label', COPY.install_label);
      const list = el(block, 'ul', 'pp-install-list');
      for (const command of tool.install) commandRow(list, packSlug, tool, command, PACK_PROGRAMS_INSTALL_ATTR);
      copyErrorLine(block);
    }
    for (const docs of tool.docs) {
      const link = el(block, 'a', 'rx-link pp-docs', COPY.docs);
      link.setAttribute('href', docs);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  };

  /** `readOnly` — D-321 C1: a pack not installed yet. Its state and how to install
   *  the program are said; a location and Refuse / Warn are stored per installed
   *  catalog, so they wait for the install. */
  const renderTool = (parent: HTMLElement, packSlug: string, tool: PackToolStatus, readOnly = false): void => {
    const row = el(parent, 'li', 'pp-row');
    row.setAttribute(PACK_PROGRAMS_ROW_ATTR, tool.catalog);
    row.setAttribute(PACK_PROGRAMS_STATE_ATTR, tool.state);
    row.setAttribute('data-tone', programStopsRuns(tool) ? 'danger' : 'muted');
    const head = el(row, 'div', 'pp-head');
    const name = el(head, 'span', 'pp-name', programDisplayName(tool.binary));
    name.title = tool.binary;
    el(head, 'span', 'pp-state', programStateText(tool));
    if (tool.detail !== undefined) el(row, 'p', 'pp-detail', tool.detail);
    if (tool.tested !== undefined) el(row, 'p', 'pp-note', COPY.tested(describeTestedRange(tool.tested)));
    const note = programConsequence(tool);
    if (note !== null) el(row, 'p', 'pp-consequence', note);
    if (readOnly) {
      renderInstall(row, packSlug, tool, true);
      return;
    }
    renderLocation(row, packSlug, tool);
    renderSetting(row, packSlug, tool);
    renderInstall(row, packSlug, tool);
    renderSetLocation(row, packSlug, tool);
  };

  const renderForPack = (pack: PackListEntry): HTMLElement | null => {
    if (!enabled || disposed) return null;
    if (states.get(pack.slug) === undefined) load(pack.slug);
    const current = states.get(pack.slug) ?? { status: 'loading' as const };
    if (current.status === 'unsupported') return null;
    if (current.status === 'ready' && current.tools.length === 0) return null;
    const section = doc.createElement('section');
    section.setAttribute(PACK_PROGRAMS_ATTR, pack.slug);
    el(section, 'h4', 'pp-heading', COPY.heading);
    if (current.status === 'loading') {
      el(section, 'p', 'pp-note', COPY.loading);
      return section;
    }
    if (current.status === 'error') {
      const error = el(section, 'p', 'pp-error', COPY.load_failed(current.message));
      error.setAttribute(PACK_PROGRAMS_ERROR_ATTR, '');
      const retry = button(section, COPY.retry, false, false, () => {
        load(pack.slug);
        changed();
      });
      retry.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'retry');
      markFor(retry, pack.slug);
      return section;
    }
    el(section, 'p', 'pp-note', current.installed ? COPY.intro : COPY.intro_before_install);
    const writeError = writeErrors.get(pack.slug);
    if (writeError !== undefined) {
      const error = el(section, 'p', 'pp-error', COPY.action_failed(writeError));
      error.setAttribute(PACK_PROGRAMS_ERROR_ATTR, '');
    }
    const list = el(section, 'ul', 'pp-list');
    for (const tool of current.tools) renderTool(list, pack.slug, tool, !current.installed);
    const isBusy = busy.has(pack.slug);
    const again = button(section, isBusy ? COPY.checking : COPY.check_again, false, isBusy, () => {
      writeErrors.delete(pack.slug);
      load(pack.slug, 'recheck');
      changed();
    });
    again.className += ' pp-check';
    again.setAttribute(PACK_PROGRAMS_ACTION_ATTR, 'check-again');
    markFor(again, pack.slug);
    return section;
  };

  return {
    enabled,
    refresh: () => {
      states.clear();
      writeErrors.clear();
      busy.clear();
      newestRead.clear();
      copied = null;
      copyError = null;
      drafts.clear();
      openLocate.clear();
    },
    renderForPack,
    toolsFor: (packSlug) => {
      const state = states.get(packSlug);
      return state?.status === 'ready' ? state.tools : null;
    },
    whenSettled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    dispose: () => {
      disposed = true;
      inFlight = new Set();
    },
  };
};

export const PACK_PROGRAMS_STYLES = `
[${PACK_PROGRAMS_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  margin: 10px 0 2px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e5e5e5);
}
[${PACK_PROGRAMS_ATTR}] .pp-heading {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted, #666);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
[${PACK_PROGRAMS_ATTR}] .pp-note,
[${PACK_PROGRAMS_ATTR}] .pp-install-label {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted, var(--muted, #666));
  overflow-wrap: anywhere;
}
[${PACK_PROGRAMS_ATTR}] .pp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${PACK_PROGRAMS_ATTR}] .pp-state {
  color: var(--fg-muted, var(--muted, #666));
}
[${PACK_PROGRAMS_ATTR}] .pp-row[data-tone="danger"] .pp-state {
  color: var(--danger, #b3261e);
}
[${PACK_PROGRAMS_ATTR}] .pp-detail {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${PACK_PROGRAMS_ATTR}] .pp-consequence {
  margin: 0;
  font-size: 12px;
}
[${PACK_PROGRAMS_ATTR}] .pp-setting {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-choices {
  display: inline-flex;
  gap: 6px;
}
[${PACK_PROGRAMS_ATTR}] .pp-install {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-install-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-install-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-command {
  min-width: 0;
  max-width: 100%;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-sunk, var(--bg-muted, #f4f4f4));
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${PACK_PROGRAMS_ATTR}] .pp-check {
  align-self: flex-start;
}
[${PACK_PROGRAMS_ATTR}] .pp-location {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}
[${PACK_PROGRAMS_ATTR}] .pp-use-found {
  align-self: flex-start;
  max-width: 100%;
  overflow-wrap: anywhere;
}
[${PACK_PROGRAMS_ATTR}] .pp-locate {
  font-size: 12px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-locate-summary {
  cursor: pointer;
  color: var(--fg-muted, var(--muted, #666));
}
[${PACK_PROGRAMS_ATTR}] .pp-locate-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  min-width: 0;
}
[${PACK_PROGRAMS_ATTR}] .pp-locate-input {
  flex: 1 1 16rem;
  min-width: 0;
  max-width: 100%;
  padding: 4px 6px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
[${PACK_PROGRAMS_ATTR}] .pp-error {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--danger-bg, var(--danger-weak));
  color: var(--danger);
  word-break: break-word;
}
`;
