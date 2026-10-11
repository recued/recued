/** D-321 — what a cli pack's probe, tested range and install hints must be.
 *  Shared by the authoring validator (the pack's `cli` cell) and the catalog
 *  validator (`surfaces.connector.runtime.cli_*`), which is all a directly
 *  published catalog meets. Each check returns problems with a path relative
 *  to the value it was given; the caller adds its own path and issue code. */

import {
  CLI_INSTALL_MANAGERS,
  CLI_INSTALL_PACKAGE_PATTERN,
  CLI_INSTALL_SYSTEMS,
  CLI_TOOL_VERSION_PATTERN,
  CLI_VERSION_OUTSIDE,
  CLI_VERSION_PROBE_FLAGS,
  compareToolVersions,
} from '@recued/contracts';

export interface CliToolPolicyProblem {
  /** Relative to the checked value: `''` for the value itself, else
   *  `tested.from`, `[1].docs`, … */
  path: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const keysOutside = (value: Record<string, unknown>, allowed: readonly string[]): string[] =>
  Object.keys(value).filter((key) => !allowed.includes(key));

const isToolVersion = (value: unknown): value is string =>
  typeof value === 'string' && CLI_TOOL_VERSION_PATTERN.test(value);

/** `{ tested: { from, before? }, outside }`, closed at both levels, with `from`
 *  below `before`. */
export const cliVersionProblems = (version: unknown): CliToolPolicyProblem[] => {
  if (!isRecord(version)) {
    return [{ path: '', message: 'version must be an object: { tested: { from, before? }, outside }' }];
  }
  const out: CliToolPolicyProblem[] = [];
  for (const key of keysOutside(version, ['tested', 'outside'])) {
    out.push({
      path: key,
      message: key === 'pattern'
        ? 'version.pattern is not supported: the version is the first dotted number in the first line the probe prints'
        : `version.${key} is not a version setting (tested, outside)`,
    });
  }
  const tested = version.tested;
  if (!isRecord(tested)) {
    out.push({ path: 'tested', message: 'version.tested must be an object: { from, before? }' });
  } else {
    for (const key of keysOutside(tested, ['from', 'before'])) {
      out.push({ path: `tested.${key}`, message: `version.tested.${key} is not part of a range (from, before)` });
    }
    if (!isToolVersion(tested.from)) {
      out.push({ path: 'tested.from', message: 'version.tested.from must be a version such as 1.18.35: one to four whole numbers joined by dots' });
    }
    if (tested.before !== undefined && !isToolVersion(tested.before)) {
      out.push({ path: 'tested.before', message: 'version.tested.before must be a version such as 2.0.0: one to four whole numbers joined by dots' });
    }
    if (isToolVersion(tested.from) && isToolVersion(tested.before)
      && compareToolVersions(tested.from, tested.before) >= 0) {
      out.push({ path: 'tested.before', message: `version.tested.before (${tested.before}) must be above from (${tested.from})` });
    }
  }
  if (!(CLI_VERSION_OUTSIDE as readonly unknown[]).includes(version.outside)) {
    out.push({ path: 'outside', message: `version.outside must be ${CLI_VERSION_OUTSIDE.join(' or ')}` });
  }
  return out;
};

const isHttpsLink = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
};

/** A non-empty list of `{ manager, package, systems? }` (a manager from the
 *  closed list) or `{ docs }` (an https link), each closed. */
export const cliInstallProblems = (install: unknown): CliToolPolicyProblem[] => {
  if (!Array.isArray(install) || install.length === 0) {
    return [{ path: '', message: 'install must be a non-empty array of { manager, package, systems? } or { docs }' }];
  }
  const out: CliToolPolicyProblem[] = [];
  install.forEach((entry: unknown, i) => {
    const at = `[${String(i)}]`;
    if (!isRecord(entry)) {
      out.push({ path: at, message: 'an install hint must be { manager, package, systems? } or { docs }' });
      return;
    }
    if ('docs' in entry) {
      for (const key of keysOutside(entry, ['docs'])) {
        out.push({ path: `${at}.${key}`, message: `a docs hint carries only docs, not ${key}` });
      }
      if (!isHttpsLink(entry.docs)) {
        out.push({ path: `${at}.docs`, message: 'docs must be an https link, with no user name or password' });
      }
      return;
    }
    for (const key of keysOutside(entry, ['manager', 'package', 'systems'])) {
      out.push({ path: `${at}.${key}`, message: `${key} is not an install hint setting (manager, package, systems)` });
    }
    if (!(CLI_INSTALL_MANAGERS as readonly unknown[]).includes(entry.manager)) {
      out.push({ path: `${at}.manager`, message: `manager must be one of ${CLI_INSTALL_MANAGERS.join(', ')}` });
    }
    if (typeof entry.package !== 'string' || !CLI_INSTALL_PACKAGE_PATTERN.test(entry.package)) {
      out.push({
        path: `${at}.package`,
        message: 'package must be letters, digits and @ / . _ + -, start with a letter, a digit or @, and be at most 214 characters',
      });
    }
    if (entry.systems !== undefined) {
      const systems = entry.systems;
      const ok = Array.isArray(systems) && systems.length > 0
        && systems.every((s) => (CLI_INSTALL_SYSTEMS as readonly unknown[]).includes(s))
        && new Set(systems).size === systems.length;
      if (!ok) {
        out.push({ path: `${at}.systems`, message: `systems must list one or more of ${CLI_INSTALL_SYSTEMS.join(', ')}, each once` });
      }
    }
  });
  return out;
};

/** `probe[0]` is the launched binary, the pin each op's argv[0] has. When the
 *  server runs the probe (`versionOnly`: the pack declares a range), it may
 *  only ask for the version: the server runs it outside any grant. */
export const cliProbeProblems = (
  probe: unknown,
  launched: string | undefined,
  versionOnly: boolean,
): CliToolPolicyProblem[] => {
  if (!Array.isArray(probe) || probe.length === 0
    || !probe.every((token) => typeof token === 'string' && token.length > 0)) {
    return [{ path: '', message: 'probe must be a non-empty array of non-empty strings' }];
  }
  const out: CliToolPolicyProblem[] = [];
  if (launched !== undefined && probe[0] !== launched) {
    out.push({ path: '[0]', message: `probe[0] '${String(probe[0])}' must be the launched binary '${launched}', as each op's argv[0] is` });
  }
  if (versionOnly
    && !(probe.length === 2 && (CLI_VERSION_PROBE_FLAGS as readonly unknown[]).includes(probe[1]))) {
    out.push({
      path: '',
      message: `the server runs this probe on its own, outside any grant, so it may only ask for the version: [binary, ${CLI_VERSION_PROBE_FLAGS.join(' | ')}]`,
    });
  }
  return out;
};
