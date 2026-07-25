/** D-118 Phase 3 — `docker_pull` installer kind.
 *
 *  Pulls a docker image into the local daemon. Upgrade applies a
 *  new tag (the `target` field on the manifest's `upgrade[]`
 *  entry); uninstall removes the image via `docker rmi`.
 */

import { defaultSpawn } from './process.js';
import { ownSafe } from '../key-safety.js';
import {
  InstallerParamError,
  type InstallerContext,
  type InstallerKindModule,
  type InstallerOutcome,
} from './types.js';

export interface DockerPullParams {
  /** Image reference, e.g. `ollama/ollama:latest`. */
  image: string;
  /** Optional override applied during upgrade — if the manifest
   *  ships `image: "foo:0.1"` and the user upgrades to `0.2`,
   *  `target` carries the new tag. */
  target?: string;
}

export const validateDockerPullParams = (raw: unknown): DockerPullParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new InstallerParamError('docker_pull', 'params must be an object');
  }
  const params = raw as Record<string, unknown>;
  const image = ownSafe(params, 'image');
  const target = ownSafe(params, 'target');
  if (typeof image !== 'string' || image === '') {
    throw new InstallerParamError('docker_pull', 'image required (string)');
  }
  if (
    target !== undefined &&
    (typeof target !== 'string' || target === '')
  ) {
    throw new InstallerParamError('docker_pull', 'target must be a non-empty string when present');
  }
  return {
    image,
    ...(typeof target === 'string' ? { target } : {}),
  };
};

/** When upgrade target is a bare tag (e.g. `"0.2"`), append it to
 *  the image's repository (split on the last `:`). When it's a
 *  full reference (`"foo:0.2"` or `"reg/foo:0.2"`), use it as-is. */
const applyUpgradeTarget = (image: string, target: string): string => {
  if (target.includes(':')) return target;
  const lastColon = image.lastIndexOf(':');
  const repo = lastColon > image.lastIndexOf('/') ? image.slice(0, lastColon) : image;
  return `${repo}:${target}`;
};

const run = (
  argv: string[],
  ctx: InstallerContext,
): Promise<InstallerOutcome> => (ctx.spawn ?? defaultSpawn)(argv);

export const dockerPullInstaller: InstallerKindModule<DockerPullParams> = {
  install: ({ image }, ctx) => run(['docker', 'pull', image], ctx),
  upgrade: ({ image, target }, ctx) => {
    const next = target ? applyUpgradeTarget(image, target) : image;
    return run(['docker', 'pull', next], ctx);
  },
  uninstall: ({ image }, ctx) => run(['docker', 'rmi', image], ctx),
};
