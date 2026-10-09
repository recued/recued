/** What a pack needs from the SERVER'S own code, not just from its manifest.
 *
 *  A few lists a pack names from can only grow with a server release, because
 *  each member is host code or a reviewed name: a CLI op's progress adapter
 *  (executor code that reads the tool's output), the adapters that also read the
 *  tool's final answer, and the environment variables an op may pin. A pack
 *  published for a newer Recued names members this server's lists lack. The
 *  validator refuses it too, but in its own words — v26.10.8 answered the Pi pack
 *  with "output_capture.from_progress_answer requires a heartbeat progress whose
 *  adapter reads a final answer (claude-stream-json)" (measured 2026-10-08), which
 *  tells an owner nothing to do. The remedy is to update Recued, so say that.
 *
 *  ⚠ A server can only name what IT has a list for: this helps servers from the
 *  release that carries it on, never an older one. */
import {
  CLI_BINDING_ENV_NAMES,
  CLI_PROGRESS_ADAPTERS,
  CLI_PROGRESS_ANSWER_ADAPTERS,
  normalizeBulkPackInstallPlan,
  type BulkPackManifest,
} from '@recued/contracts';

const ADAPTERS: ReadonlySet<string> = new Set(CLI_PROGRESS_ADAPTERS);
const ANSWER_ADAPTERS: ReadonlySet<string> = new Set(CLI_PROGRESS_ANSWER_ADAPTERS);
const ENV_NAMES: ReadonlySet<string> = new Set(CLI_BINDING_ENV_NAMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Each part of this server's code the pack's compositions use and this server
 *  lacks, in words an owner can read, in the order first met, without repeats. */
export const unknownHostCapabilities = (manifest: BulkPackManifest): string[] => {
  const found = new Set<string>();
  for (const content of normalizeBulkPackInstallPlan(manifest).contents) {
    if (content.type !== 'composition') continue;
    const operations = (content.composition as { operations?: unknown }).operations;
    if (!Array.isArray(operations)) continue;
    for (const operation of operations) {
      const bind = isRecord(operation) ? operation.bind : undefined;
      if (!isRecord(bind)) continue;
      const progress = isRecord(bind.progress) ? bind.progress : undefined;
      const adapter = typeof progress?.adapter === 'string' ? progress.adapter : undefined;
      if (adapter !== undefined && !ADAPTERS.has(adapter)) {
        found.add(`the "${adapter}" progress adapter`);
      } else if (adapter !== undefined && isRecord(bind.output_capture)
        && bind.output_capture.from_progress_answer === true && !ANSWER_ADAPTERS.has(adapter)) {
        found.add(`answers read through the "${adapter}" progress adapter`);
      }
      if (isRecord(bind.env)) {
        for (const name of Object.keys(bind.env)) {
          if (!ENV_NAMES.has(name)) found.add(`the pinned environment variable "${name}"`);
        }
      }
    }
  }
  return [...found];
};

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;

/** The refusal an owner reads: which pack needs a newer Recued, what this server
 *  lacks, which of the packs it would install uses it, and what to do. */
export const newerServerMessage = (
  root: BulkPackManifest,
  needs: ReadonlyArray<{ manifest: BulkPackManifest; uses: readonly string[] }>,
): string => {
  const lacking = [...new Set(needs.flatMap((need) => need.uses))];
  const users = needs.length === 1 && needs[0]!.manifest.slug === root.slug
    ? 'it uses'
    : `${listed(needs.map((need) => need.manifest.name))} ${needs.length === 1 ? 'uses' : 'use'}`;
  return `packs.install: ${root.name} needs a newer version of Recued. This server does not have `
    + `${listed(lacking)}, which ${users}. Update Recued, then install ${root.name} again.`;
};
