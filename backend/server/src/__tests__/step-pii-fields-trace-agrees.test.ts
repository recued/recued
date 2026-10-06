/**
 * What the PII trace credits a step-level `pii_fields` entry with must be what the
 * dispatch hash actually replaces — through the server's real canonical classifier.
 *
 * ⛔ They disagreed on lists. The classifier profiles mail `to` / `cc` (address
 * arrays) as plain paths, so the trace counted a `to` entry as cover while the hash
 * walked the array and sent every address — and auto-PII, reading the trace, added no
 * tag of its own. Naming `to` left the addresses less protected than naming nothing.
 */
import { tracePiiFlow } from '@recued/contracts';
import { hashStepPiiFields } from '@recued/transforms';
import { describe, expect, it } from 'vitest';

import { createCanonicalPiiSourceClassifier } from '../pii-trace-classifier.js';

const classifier = createCanonicalPiiSourceClassifier();

/** A `data.mail` record's hot fields as `mail-get` returns them: `to` / `cc` are lists. */
const hotFields = {
  from: 'dana@northwind.example',
  to: ['lee@acme.example', 'kim@acme.example'],
  cc: ['pat@acme.example'],
  subject: 'Renewal for Acme',
};

const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
    value,
  );
const leaves = (value: unknown): unknown[] =>
  value == null ? []
    : Array.isArray(value) ? value.flatMap(leaves)
      : typeof value === 'object' ? Object.values(value).flatMap(leaves)
        : [value];

describe('step pii_fields — the trace credits exactly what the dispatch hash replaces', () => {
  for (const names of [['to'], ['cc'], ['from'], ['subject'], ['to', 'cc', 'from']]) {
    it(`pii_fields ${JSON.stringify(names)}`, () => {
      const finding = tracePiiFlow({
        steps: [
          { id: 'mail', ingredient: 'mail-get', input: {} },
          {
            id: 'ai',
            ingredient: 'ai-classify',
            pii_fields: names,
            input: { 'llm.data': '{{step.mail.record.hot_fields}}' },
          },
        ],
      }, classifier).findings.find((f) => f.step_id === 'ai')!;
      const uncovered = new Set(finding.uncovered.map((u) => u.path));
      const hashed = hashStepPiiFields(hotFields, names).data;

      for (const path of Object.keys(hotFields)) {
        const sent = leaves(at(hashed, path));
        if (uncovered.has(path)) {
          expect(sent, `${path} is reported uncovered, so it goes as it is`).toEqual(leaves(at(hotFields, path)));
        } else {
          expect(sent.length, `${path} has values`).toBeGreaterThan(0);
          expect(sent.every((v) => /^HASH_STEP_[0-9a-f]{8}$/.test(String(v))), `${path} is credited, so every value is a token`)
            .toBe(true);
        }
      }
      // Every field is classified, so each is either credited or reported.
      expect(Object.keys(hotFields).filter((p) => !uncovered.has(p)).sort()).toEqual([...names].sort());
    });
  }
});
