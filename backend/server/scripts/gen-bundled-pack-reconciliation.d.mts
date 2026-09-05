export const PACK_RECONCILIATION_TARGET_SLUGS: readonly string[];
export function derivePackReconciliationTargets(
  repoRoot: string,
): Record<string, Record<string, unknown> & { slug: string }>;
export function renderPackReconciliationModule(
  targets: Record<string, Record<string, unknown> & { slug: string }>,
): string;
