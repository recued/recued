/** The one AAD-migration assertion whose SUBJECT is the bridge.
 *
 *  ⛔⛔ IT LIVES ALONE BECAUSE OMISSION IS PER FILE. `token-aad-migration.test.ts`
 *  holds thirteen assertions about surfaces the public source distribution
 *  actually ships; this one reads `apps/bridge`, which it does not. Leaving the
 *  two together forces a choice between dropping all fourteen from public CI and
 *  shipping one that reds on a file that is not there — and it DID red, in the
 *  exported suite at release step 5, after the import scanner missed it.
 *
 *  🔑 THE SCANNER MISSED IT BECAUSE THE PATH WAS ASSEMBLED FROM SEGMENTS.
 *  `resolve(dirname, '..', '..', '..', 'bridge', 'src', …)` contains no literal
 *  that equals or starts with a private root, so `repositoryPathReferences`
 *  cannot see it, and nothing pruned the file. The single literal below is what
 *  makes this file's dependency VISIBLE to the exporter — keep it one string.
 *
 *  ⇒ Do not "tidy" the path back into segments, and do not make the assertion
 *  conditional on the file existing: a test named for a guarantee that silently
 *  skips is worse than one that is honestly absent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AAD v1 → v2 — the bridge half', () => {
  it('⛔ the bridge really has no v1 reader — the claim, checked', () => {
    // A comment asserting "no v1 reader here" is the shape this whole review
    // kept finding false. Checked instead.
    const bridgeStore = readFileSync(
      resolve(import.meta.dirname, '../../../bridge/src/storage/token-store.ts'),
      'utf-8',
    );
    expect(bridgeStore).not.toMatch(/const buildAadBytesV1\s*=/);
    expect(bridgeStore).not.toMatch(/aad\.v1/);
    // …and it does still seal v2, so this is "no legacy reader", not "no store".
    expect(bridgeStore).toMatch(/additional_data:\s*buildAadBytesV2\(/);
  });
});
