/** D-321 — a program the server's PATH does not reach, found where installers
 *  put programs (internal design notes § 2.1, option a).
 *
 *  A server started at login gets the PATH its service manager gives it, not the
 *  one the owner's terminal has: launchd gives a LaunchAgent
 *  `/usr/bin:/bin:/usr/sbin:/sbin`. Measured 2026-11-07 on one Mac: 35 of the 61
 *  cli-pack programs installed there were outside it (everything from Homebrew,
 *  npm, Docker Desktop and the vendors' own installers), so each read "Not
 *  installed", and the page offered to install a program that was already there.
 *
 *  So before a missing program is called not installed, look where installers
 *  put programs. A file found there is only REPORTED: it is never run, and its
 *  folder is never added to the PATH. Which folders the server searches stays
 *  the owner's choice, made in the terminal they install from (option b). */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { compareToolVersions } from '@recued/contracts';

import { createCliBinaryPathResolver } from './cli-binary-reachability.js';
import { childOfInstallSupervisor } from './lifecycle/supervisor.js';

export interface ProgramOutsidePath {
  /** The file found, e.g. `/opt/homebrew/bin/rg`. */
  found_at: string;
  /** The installer re-run that gives the server a terminal's PATH. Present only
   *  when the installer's own LaunchAgent or systemd unit started the server. */
  repair?: string;
}

export interface OutsidePathOptions {
  /** The PATH the server's actions get. Default `process.env.PATH`. */
  path?: string;
  /** Default `os.homedir()`. */
  home?: string;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether the installer's LaunchAgent or systemd unit started this server.
   *  Default: this process is the child of its install's `recued-supervise`,
   *  and not root. */
  startedByInstaller?: () => boolean;
  /** The server's release channel. Default `process.env.RECUED_CHANNEL`. */
  channel?: string;
  /** A folder's entries, or none (nvm's versions). Injected by tests. */
  listDir?: (dir: string) => string[];
}

const INSTALL_SCRIPT_URL = 'https://recued.com/install.sh';
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const NVM_VERSION = /^v\d{1,9}(?:\.\d{1,9}){0,3}$/u;

const readFolder = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Each installed Node's `bin` under nvm, newest first: `npm install -g` puts a
 *  tool beside the Node that was current then. */
const nvmFolders = (home: string, listDir: (dir: string) => string[]): string[] => {
  const root = join(home, '.nvm', 'versions', 'node');
  return listDir(root)
    .filter((name) => NVM_VERSION.test(name))
    .sort((a, b) => compareToolVersions(b.slice(1), a.slice(1)))
    .map((name) => join(root, name, 'bin'));
};

/** Where the package managers in pack install hints, and the vendor installers
 *  measured, put programs. */
const usualFolders = (home: string, platform: NodeJS.Platform, listDir: (dir: string) => string[]): string[] => {
  const brew = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin']
    : ['/home/linuxbrew/.linuxbrew/bin', join(home, '.linuxbrew', 'bin')];
  const system = platform === 'linux'
    ? ['/usr/local/bin', '/usr/local/sbin', '/snap/bin']
    : ['/usr/local/bin', '/usr/local/sbin'];
  const user = ['.local/bin', '.cargo/bin', 'go/bin', '.bun/bin', '.deno/bin', '.volta/bin', '.npm-global/bin', '.opencode/bin']
    .map((dir) => join(home, dir));
  return [...brew, ...system, ...user, ...nvmFolders(home, listDir)];
};

/** The file a bare program name names in a usual folder the PATH leaves out.
 *  Never on Windows, where the server inherits the owner's own PATH, and never
 *  for a path-bearing name, which is not looked up on PATH at all. */
export const findProgramOutsidePath = (binary: string, opts: OutsidePathOptions = {}): string | undefined => {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' || binary.includes('/') || binary.includes('\\')) return undefined;
  const onPath = new Set((opts.path ?? process.env.PATH ?? '').split(':'));
  const folders = usualFolders(opts.home ?? homedir(), platform, opts.listDir ?? readFolder)
    .filter((dir) => !onPath.has(dir));
  return createCliBinaryPathResolver({ path: folders.join(':'), delimiter: ':', platform })(binary);
};

/** The installer re-run that rewrites the LaunchAgent or systemd unit with the
 *  PATH of the terminal it runs in. It names the server's own channel: a plain
 *  re-run means stable, and on an edge install it would move the owner to it. */
export const installerRepairCommand = (channel: string | undefined): string => {
  const pin = channel !== undefined && channel !== 'stable' && CHANNEL_PATTERN.test(channel)
    ? `RECUED_CHANNEL=${channel} `
    : '';
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | ${pin}sh`;
};

let startedByInstallerAnswer: boolean | undefined;

/** Read once per process: how the server started does not change while it runs.
 *  Not as root: a root server's unit is the system one, and a re-run under sudo
 *  would give it sudo's PATH, not the owner's. */
const startedByInstallerDefault = (): boolean => {
  startedByInstallerAnswer ??= process.getuid?.() !== 0 && childOfInstallSupervisor();
  return startedByInstallerAnswer;
};

/** The sentences a run's `CLI_TOOL_NOT_FOUND` adds when the program was found:
 *  where it is, and how the owner gives the server that folder. They replace
 *  the install advice, since the program is installed. */
export const describeProgramOutsidePath = (outside: ProgramOutsidePath): string => {
  const folder = dirname(outside.found_at);
  const where = `It is installed at ${outside.found_at}, but the server's PATH does not include ${folder}.`;
  if (outside.repair === undefined) {
    return `${where} Start the server from a terminal where it works, or add ${folder} to the PATH the server starts with.`;
  }
  return `${where} To give the server the PATH of a terminal where it works, run Recued's installer again from that terminal: ${outside.repair}`;
};

/** A missing program found outside the server's PATH, with the repair when the
 *  installer started the server; undefined when it is not found there either. */
export const programOutsidePath = (binary: string, opts: OutsidePathOptions = {}): ProgramOutsidePath | undefined => {
  const found_at = findProgramOutsidePath(binary, opts);
  if (found_at === undefined) return undefined;
  if (!(opts.startedByInstaller ?? startedByInstallerDefault)()) return { found_at };
  return { found_at, repair: installerRepairCommand(opts.channel ?? process.env.RECUED_CHANNEL) };
};
