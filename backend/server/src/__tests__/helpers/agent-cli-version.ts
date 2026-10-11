/** D-321 slice 4 — what a live drive records about the tool it ran.
 *
 *  Reads the installed tool's version the way the server does before an action
 *  runs: the pack's own probe, through the real status service, against the range
 *  the pack's catalog declares. It runs in the drive's process environment, which
 *  each drive points at throwaway folders before anything runs, so the probe
 *  touches no owner configuration. The line it prints is the drive's record of
 *  the version it passed on; the drive asserts the state is `ready`. */

import { describeTestedRange, type IngredientManifest } from '@recued/contracts';

import { createCliToolStatus, type CliToolStatusReport } from '../../cli-tool-status.js';

export const readPackToolVersion = async (catalog: IngredientManifest): Promise<CliToolStatusReport> => {
  const runtime = catalog.surfaces?.connector?.runtime;
  const probe = runtime?.cli_probe;
  const version = runtime?.cli_version;
  if (probe === undefined || version === undefined) {
    throw new Error(`${catalog.slug} declares no tested range, so there is no version to check`);
  }
  const report = await createCliToolStatus().check({ probe, tested: version.tested });
  const read = report.probe_result?.kind === 'version' ? report.probe_result.version : 'no version read';
  console.log(`[d-321] ${catalog.slug}: ${probe[0]} ${read} — ${report.state}, `
    + `for ${describeTestedRange(version.tested)}`);
  return report;
};
