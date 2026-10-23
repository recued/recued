import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Where a browser run keeps its artifacts. The Playwright config ships in the
// public export, which refuses an import of scripts/, so the config and the
// runner (scripts/lib/webclient-e2e-runner.mjs) share this module from here.

// Required Playwright values may start with "-", including "--". Protect
// them before interpreting runner flags. The fixture tests check every such
// option against the installed Playwright command definitions.
const valueOptions = new Set([
  '--browser', '--config', '-c', '--global-timeout', '--grep', '-g', '--grep-invert', '-G',
  '--workers', '-j', '--last-failed-file', '--max-failures', '--output', '--project',
  '--repeat-each', '--reporter', '--retries', '--run-agents', '--shard', '--test-list',
  '--test-list-invert', '--timeout', '--trace', '--tsconfig', '--ui-host', '--ui-port',
  '--update-source-method',
]);

// -x is Playwright's boolean short option; a following value option in a
// cluster (for example -xg) still consumes the next token.
export const consumesPlaywrightValue = (arg) => valueOptions.has(arg) || /^-x+[cgGj]$/.test(arg);

export const WEBCLIENT_E2E_OUTPUT_ENV = 'RECUED_WEBCLIENT_E2E_OUTPUT_DIR';
export const WEBCLIENT_E2E_DEFAULT_LAST_RUN_ENV = 'RECUED_WEBCLIENT_E2E_DEFAULT_LAST_RUN_FILE';
export const newArtifactDirectory = (artifacts) => resolve(artifacts, 'runs',
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());

/** Config loads again in workers, which inherit the run's directory. No files are created here. */
export const configureWebclientArtifacts = (directory) => {
  const artifacts = resolve(directory, '.playwright-artifacts');
  process.env[WEBCLIENT_E2E_OUTPUT_ENV] ||= newArtifactDirectory(artifacts);
  let explicitOutput = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--output' || arg.startsWith('--output=')) { explicitOutput = true; break; }
    if (consumesPlaywrightValue(arg)) index += 1;
  }
  // Keep --last-failed useful across fresh run directories. Playwright's explicit
  // --last-failed-file and caller environment still take precedence. An explicit
  // --output keeps Playwright's usual receipt inside that chosen directory.
  if (!explicitOutput && !process.env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE) {
    process.env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE = resolve(artifacts, '.last-run.json');
    process.env[WEBCLIENT_E2E_DEFAULT_LAST_RUN_ENV] = process.env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE;
  }
  return process.env[WEBCLIENT_E2E_OUTPUT_ENV];
};
