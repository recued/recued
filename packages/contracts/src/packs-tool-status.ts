/** D-321 slice 3 — `packs.tool_status`: whether each installed pack's programs
 *  are ready on this server, read per call and never stored.
 *
 *  It feeds the pack list's badge ("Needs opencode", "opencode 2.0.1 not
 *  tested", "ffmpeg does not start") and the Programs block on a pack's page.
 *  A tool whose pack declares a tested range is probed (cached on the server
 *  until its file or PATH changes, an hour at most); any other is looked up on
 *  PATH only and never run (R5). The install commands are written for the
 *  server's own system, which the webclient cannot know, and are shown, never
 *  run (D-170). */

import type {
  CliInstallSystem,
  CliToolState,
  CliToolVersionPolicy,
  CliVersionOutside,
} from './cli-tool-version.js';

/** One program a pack runs. */
export interface PackToolStatus {
  /** The cli catalog that runs it: the key the owner's choice is stored under. */
  catalog: string;
  /** The program, as the pack launches it (`opencode`, `claude`, `ffmpeg`). */
  binary: string;
  state: CliToolState;
  /** The version the probe read, when it read one. */
  version?: string;
  /** Why the tool is `broken` or `unreadable`, in a few words, or the line it
   *  printed. */
  detail?: string;
  /** When the version was read; a cached read keeps its own time. */
  checked_at?: number;
  /** The versions the pack was tested with. Absent when it declares none, and
   *  then the tool is not probed. */
  tested?: CliToolVersionPolicy['tested'];
  /** What a run does outside the range: the owner's choice while it applies,
   *  else the pack's default. Absent without a range. */
  outside?: CliVersionOutside;
  /** The pack's declared default. */
  pack_outside?: CliVersionOutside;
  /** The owner's stored choice, when there is one, whether or not it applies. */
  owner_outside?: CliVersionOutside;
  /** The owner chose for an older range or default, so the pack's default
   *  applies until they choose again. */
  stale_owner_choice?: true;
  /** Install commands for this server's system, in the order the pack lists
   *  them. Empty when the pack gives none for it. */
  install: string[];
  /** Links to the tool's own install instructions. */
  docs: string[];
}

export interface PackToolStatusEntry {
  /** The pack's owner-facing slug, as `#packs/<slug>` takes it. */
  slug: string;
  tools: PackToolStatus[];
}

export interface PacksToolStatusRequest {
  /** One pack (its page). Absent: every installed pack (the list). */
  pack_slug?: string;
  /** "Check again": forget the cached version reads of the listed tools first,
   *  so each is probed now. */
  recheck?: boolean;
}

export interface PacksToolStatusResult {
  /** The system the install commands are written for. */
  system: CliInstallSystem;
  /** Installed packs that run at least one program; other packs are left out. */
  packs: PackToolStatusEntry[];
}
