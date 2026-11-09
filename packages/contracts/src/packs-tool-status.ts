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
  /** A `missing` program found where installers put programs, outside the PATH
   *  the server started with: the file found (`/opt/homebrew/bin/rg`). It is
   *  installed, so its install commands are the wrong advice. */
  found_at?: string;
  /** With `found_at`, when the installer's own LaunchAgent or systemd unit
   *  started the server: the installer re-run that gives the server the PATH of
   *  the terminal it runs in. Shown, never run. */
  repair?: string;
  /** D-321 — the location the owner set for this program, while it applies
   *  (`owner-tool-path.ts`): the server runs this file, and `state` is its
   *  state. Absent: the server looks on its PATH. */
  owner_path?: string;
  /** D-346 — the catalog `owner_path` was set on, when it is not this one: a
   *  Kitchen copy (D-333) with no location of its own runs its original's. A
   *  location set on the copy replaces it; clearing the copy's changes nothing. */
  owner_path_from?: string;
}

export interface PackToolStatusEntry {
  /** The pack's owner-facing slug, as `#packs/<slug>` takes it. */
  slug: string;
  tools: PackToolStatus[];
  /** D-321 C1 — `false`: the pack is not installed, and these are the programs
   *  it would run, checked on this server before install. Absent: installed. */
  installed?: false;
}

export interface PacksToolStatusRequest {
  /** One pack (its page). Absent: every installed pack (the list). D-321 C1 — a
   *  pack that is not installed answers too, from the manifest an install would
   *  use, marked `installed: false`. */
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
