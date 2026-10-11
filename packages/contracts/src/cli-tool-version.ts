// D-321 — the versions of its tool a cli pack was tested with, and where the
// owner gets the tool.
//
// A pack declares both in its `cli` cell (`IngredientCliConfig.version` /
// `.install`), and the decomposer carries them onto the catalog's connector
// runtime (`ConnectorRuntimeSpec.cli_version` / `.cli_install`, with the probe as
// `cli_probe`), because for a marketplace install the stored catalog is the only
// copy the server keeps. A pack that declares neither decomposes to the catalog
// it always did. Nothing here runs anything: Recued installs no tool (D-170). The
// server reads the installed version by running the probe
// (`backend/server/src/cli-tool-status.ts`) and checks it before an action runs.

/** What a run does when the installed version is outside the tested range, or
 *  its version cannot be read. The pack's value is a default; the owner can
 *  switch it per tool (D-321 § 3.4). */
export const CLI_VERSION_OUTSIDE = ['refuse', 'warn'] as const;
export type CliVersionOutside = (typeof CLI_VERSION_OUTSIDE)[number];

/** A tool version as a pack declares it: one to four whole numbers joined by
 *  dots (`1.18.35`, `2.1.296`). */
export const CLI_TOOL_VERSION_PATTERN = /^\d{1,9}(?:\.\d{1,9}){0,3}$/u;

/** The versions a pack was tested with (D-321 R3). `from` is the oldest version
 *  its live drive has passed on, as the pack now is (inclusive); `before` is the
 *  first version not tested (exclusive), the next major, and is absent for a
 *  tool still at 0.x, whose range is open above. One range per tool: supporting
 *  two major versions at once is two packs (R2). */
export interface CliToolVersionPolicy {
  tested: { from: string; before?: string };
  outside: CliVersionOutside;
}

/** The package managers an install hint may name. Recued writes the command
 *  from the manager and the package and never runs it (D-170), so a pack
 *  cannot put an arbitrary shell line in front of the owner (D-321 R4). */
export const CLI_INSTALL_MANAGERS = ['brew', 'winget', 'scoop', 'apt', 'dnf', 'npm', 'pip', 'pipx', 'cargo', 'go'] as const;
export type CliInstallManager = (typeof CLI_INSTALL_MANAGERS)[number];

export const CLI_INSTALL_SYSTEMS = ['macos', 'linux', 'windows'] as const;
export type CliInstallSystem = (typeof CLI_INSTALL_SYSTEMS)[number];

/** A package name an install hint may carry: letters, digits and `@ / . _ + -`,
 *  starting with a letter, a digit or `@` (an npm scope), so it never reads as
 *  a flag or a path. 214 characters at most, npm's own limit. */
export const CLI_INSTALL_PACKAGE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@/._+-]{0,213}$/u;

/** One install hint: a package from a manager, for the systems it applies to
 *  (all when absent), or an https link to the tool's own install docs. */
export type CliInstallHint =
  | { manager: CliInstallManager; package: string; systems?: CliInstallSystem[] }
  | { docs: string };

/** The arguments a probe may give its tool when the pack declares `version`:
 *  a request for the version and nothing else. The server runs that probe on
 *  its own, outside the owner's grants on the pack's actions, so a probe such
 *  as `opencode run …` would be an action nobody granted. */
export const CLI_VERSION_PROBE_FLAGS = ['--version', '-version', '-v', '-V', 'version'] as const;

/** Compare two versions that match `CLI_TOOL_VERSION_PATTERN`, number by
 *  number, a missing number read as 0 (`2.0` equals `2.0.0`). */
export const compareToolVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

const firstLine = (text: string): string | undefined =>
  text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0);

/** The installed version, read from what the probe printed (D-321 § 3.3): the
 *  first dotted number in the first line that is not blank, on stdout, then on
 *  stderr. It reads every tool measured on 2026-10-09: `1.18.35` (opencode),
 *  `1.1.0` (pi), `codex-cli 0.161.0`, `2.1.296 (Claude Code)`, and
 *  `Version: ImageMagick 7.1.2-31 Q16-HDRI …` as 7.1.2. Numbers past the fourth
 *  are dropped, and a number longer than nine digits is not a version. There is
 *  no pack-supplied pattern (§ 3.1): a regular expression from a pack, run on the
 *  server, can stall it. */
export const readToolVersion = (stdout: string, stderr: string): string | undefined => {
  for (const stream of [stdout, stderr]) {
    const line = firstLine(stream);
    if (line === undefined) continue;
    const match = /\d+(?:\.\d+)+/u.exec(line);
    if (match === null) continue;
    const parts = match[0].split('.').slice(0, 4);
    if (parts.every((part) => part.length <= 9)) return parts.join('.');
  }
  return undefined;
};

/** A catalog's `cli_version`, or undefined when it is not one: `{ tested: { from,
 *  before? }, outside }`, with `from` below `before`.
 *
 *  ⛔ CHECKED AGAIN WHERE IT IS USED. The catalog validator holds a new catalog to
 *  this shape, but a stored catalog may never have met it (an older server's
 *  validator let runtime keys through), and code that trusted it threw: a missing
 *  `tested` crashed the range compare, inside a launch's error handler. A value
 *  that is not one is no range, so nothing is checked: the same catalog chooses
 *  the program and its arguments, so a range it fails to state protects nothing
 *  more. */
export const readCliToolVersionPolicy = (value: unknown): CliToolVersionPolicy | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policy = value as Record<string, unknown>;
  const tested = policy.tested;
  if (tested === null || typeof tested !== 'object' || Array.isArray(tested)) return undefined;
  const { from, before } = tested as Record<string, unknown>;
  if (typeof from !== 'string' || !CLI_TOOL_VERSION_PATTERN.test(from)) return undefined;
  if (before !== undefined
    && (typeof before !== 'string' || !CLI_TOOL_VERSION_PATTERN.test(before) || compareToolVersions(from, before) >= 0)) {
    return undefined;
  }
  if (!(CLI_VERSION_OUTSIDE as readonly unknown[]).includes(policy.outside)) return undefined;
  return {
    tested: before === undefined ? { from } : { from, before: before as string },
    outside: policy.outside as CliVersionOutside,
  };
};

/** A catalog's `cli_probe`: a non-empty list of non-empty strings, or undefined.
 *  (Which probes the server runs is narrower still: `isVersionOnlyProbe`.) */
export const readCliProbe = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((token) => typeof token === 'string' && token.length > 0)
    ? [...(value as string[])]
    : undefined;

/** What a cli catalog's connector runtime declares for its tool, read as the
 *  gateway, the daemon supervisor and the pack page all read it: the range and
 *  its probe together (a range without its probe is none), and the install
 *  hints when they are a list. Each entry of the list is checked where it is
 *  rendered (`renderInstallHints`). */
export const cliToolPolicyOfRuntime = (
  runtime: { cli_version?: unknown; cli_probe?: unknown; cli_install?: unknown } | undefined,
): { tool_version?: { probe: string[]; version: CliToolVersionPolicy }; tool_install?: unknown[] } => {
  const version = readCliToolVersionPolicy(runtime?.cli_version);
  const probe = readCliProbe(runtime?.cli_probe);
  const install = runtime?.cli_install;
  return {
    ...(version !== undefined && probe !== undefined ? { tool_version: { probe, version } } : {}),
    ...(Array.isArray(install) ? { tool_install: install as unknown[] } : {}),
  };
};

/** True when `version` is in the tested range: `from` or later, and below
 *  `before` when the range has one. */
export const isToolVersionTested = (
  version: string,
  tested: CliToolVersionPolicy['tested'],
): boolean =>
  compareToolVersions(version, tested.from) >= 0
  && (tested.before === undefined || compareToolVersions(version, tested.before) < 0);

/** The major version a range covers when it ends at the next one (`from 1.18.35,
 *  before 2.0.0` → 1). Undefined for an open range or any other end. */
export const testedMajor = (tested: CliToolVersionPolicy['tested']): number | undefined => {
  if (tested.before === undefined) return undefined;
  const major = Number(tested.from.split('.')[0]);
  return compareToolVersions(tested.before, String(major + 1)) === 0 ? major : undefined;
};

/** The tested range in words, for a refusal and the pack's page. A range that
 *  ends at the next major reads "1.x versions from 1.18.35"; an open range,
 *  "versions from 0.161.0"; any other, "versions from 1.2.0 and below 1.5.0". */
export const describeTestedRange = (tested: CliToolVersionPolicy['tested']): string => {
  if (tested.before === undefined) return `versions from ${tested.from}`;
  const major = testedMajor(tested);
  return major !== undefined
    ? `${major}.x versions from ${tested.from}`
    : `versions from ${tested.from} and below ${tested.before}`;
};

/** D-321 — a program a run started although its version was outside the range
 *  its pack was tested with, or could not be read, because the tool's setting
 *  was Warn. Kept on the run's record for its Logs detail: when a run under
 *  Warn misbehaves, the owner can see which untested version it used. */
export interface RunUntestedTool {
  /** The program, as the pack launches it. */
  tool: string;
  /** The version the probe read, when it read one. */
  version?: string;
  tested: CliToolVersionPolicy['tested'];
  state: 'untested' | 'unreadable';
}

/** A cli tool's state on this server (D-321 § 3.3):
 *    - `ready`      — in the tested range, or on PATH when the pack declares no
 *                     range (such a tool is not probed, R5);
 *    - `missing`    — not on PATH;
 *    - `broken`     — its version probe could not start, was killed by a signal,
 *                     or timed out;
 *    - `untested`   — its probe read a version outside the range;
 *    - `unreadable` — its probe exited non-zero, or printed no version. */
export const CLI_TOOL_STATES = ['ready', 'missing', 'broken', 'untested', 'unreadable'] as const;
export type CliToolState = (typeof CLI_TOOL_STATES)[number];

/** The systems each package manager runs on. An install hint is shown on a
 *  server only where its manager runs as well as where the hint's own `systems`
 *  allow, so a pack need not spell out that winget is for Windows. */
export const CLI_INSTALL_MANAGER_SYSTEMS: Readonly<Record<CliInstallManager, readonly CliInstallSystem[]>> = {
  brew: ['macos', 'linux'],
  winget: ['windows'],
  scoop: ['windows'],
  apt: ['linux'],
  dnf: ['linux'],
  // ⛔ Not Windows: npm installs a tool there as `.cmd` and `.ps1` scripts,
  // which Node starts only through a shell, and an action is given none; the
  // command would install a tool no action can start.
  npm: ['macos', 'linux'],
  pip: ['macos', 'linux', 'windows'],
  pipx: ['macos', 'linux', 'windows'],
  cargo: ['macos', 'linux', 'windows'],
  go: ['macos', 'linux', 'windows'],
};

/** The install system a server is, from Node's `process.platform`. */
export const cliInstallSystemOf = (platform: string): CliInstallSystem =>
  platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';

/** The command one hint installs with. Where the range ends at the next major
 *  and the manager can be asked for one, the command asks for it (R4), so
 *  following a 1.x pack's hint never installs a version the pack refuses. */
const installCommand = (manager: CliInstallManager, pkg: string, major: number | undefined): string => {
  switch (manager) {
    case 'brew': return `brew install ${pkg}`;
    case 'winget': return `winget install ${pkg}`;
    case 'scoop': return `scoop install ${pkg}`;
    case 'apt': return `sudo apt install ${pkg}`;
    case 'dnf': return `sudo dnf install ${pkg}`;
    case 'npm': return major === undefined ? `npm install -g ${pkg}` : `npm install -g ${pkg}@${major}`;
    case 'pip': return major === undefined ? `pip install ${pkg}` : `pip install "${pkg}==${major}.*"`;
    case 'pipx': return major === undefined ? `pipx install ${pkg}` : `pipx install "${pkg}==${major}.*"`;
    case 'cargo': return major === undefined ? `cargo install ${pkg}` : `cargo install ${pkg} --version "^${major}"`;
    case 'go': return `go install ${pkg}@${major === undefined ? 'latest' : `v${major}`}`;
  }
};

/** An https link with no user name or password, the only docs link shown. */
const isShowableDocsLink = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
};

/** The install commands and docs links to show on a server of `system`.
 *
 *  ⛔ EVERY ENTRY IS CHECKED AGAIN HERE. The catalog validator checks hints when
 *  a catalog is published, but a catalog an older server stored was never
 *  checked for them (its validator let runtime keys through), and these
 *  commands are put in front of the owner to copy. An entry whose manager,
 *  package, systems or link does not pass is left out, never shown. */
export const renderInstallHints = (
  hints: unknown,
  system: CliInstallSystem,
  tested?: CliToolVersionPolicy['tested'],
): { commands: string[]; docs: string[] } => {
  // A range that is not one asks for no major, rather than throw.
  const major = tested !== undefined && readCliToolVersionPolicy({ tested, outside: 'refuse' }) !== undefined
    ? testedMajor(tested)
    : undefined;
  const commands: string[] = [];
  const docs: string[] = [];
  for (const raw of Array.isArray(hints) ? hints : []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const hint = raw as Record<string, unknown>;
    if ('docs' in hint) {
      if (isShowableDocsLink(hint.docs)) docs.push(hint.docs);
      continue;
    }
    const manager = hint.manager;
    if (!(CLI_INSTALL_MANAGERS as readonly unknown[]).includes(manager)) continue;
    if (typeof hint.package !== 'string' || !CLI_INSTALL_PACKAGE_PATTERN.test(hint.package)) continue;
    const systems = hint.systems;
    if (systems !== undefined
      && (!Array.isArray(systems) || !systems.every((s) => (CLI_INSTALL_SYSTEMS as readonly unknown[]).includes(s)))) {
      continue;
    }
    if (!CLI_INSTALL_MANAGER_SYSTEMS[manager as CliInstallManager].includes(system)) continue;
    if (systems !== undefined && !(systems as unknown[]).includes(system)) continue;
    commands.push(installCommand(manager as CliInstallManager, hint.package, major));
  }
  return { commands: [...new Set(commands)], docs: [...new Set(docs)] };
};
