/** ⛔⛔⛔ THE INVERSE GUARD. CLAUDE.md records the trap in one direction — a
 *  HANDLER for a kind the client never names is dead on the wire — and
 *  `apps/webclient/src/__tests__/subscriber.test.ts` derives that requirement
 *  from the reducer's own predicate.
 *
 *  Nothing guarded the other direction, and that is where the in-app
 *  notification channel died: the server EMITTED `'notification'`, no client
 *  named it, the bus dropped it (`events/bus.ts`:
 *  `if (!sub.kinds.has(stamped.kind)) continue`), and `notification-send`
 *  counted the send in `delivered_to[]`. `triage-inbox` ships that channel as
 *  its default. Every layer was typed and green.
 *
 *  🔑 SO THE RULE IS: A KIND THE SERVER PUTS ON THE BUS MUST EITHER BE NAMED BY
 *  SOME CLIENT, OR BE LISTED BELOW AS DELIBERATELY UNFANNED. The exception list
 *  is the point — "we chose not to deliver this" and "we forgot to" look
 *  identical from the code, and only one of them should be silent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Kinds emitted on purpose that NO client should receive. Each needs a reason
 *  a reader can check, not just a name. */
const DELIBERATELY_UNFANNED: ReadonlyArray<{ kind: string; why: string }> = [
  {
    kind: 'chat.connection_mcp_annotation_changed',
    why:
      'D-228 slice 4 — the panel it refreshed was deleted and the tier retired. '
      + 'The event still fires server-side (topic tags / peer signature / chat mode '
      + 'ride it); dropping it at the fan-out is the decision, recorded in '
      + 'apps/webclient/src/realtime/subscriber.ts.',
  },
];

/** Remove `//` and block comments so prose about an emit is never counted as
 *  one. Crude on purpose: it only needs to stop comment text reaching a regex,
 *  and the known-positive test proves it does not eat real code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const repoFile = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf-8');

const namedIn = (rel: string, constName: string): string[] => {
  const src = repoFile(rel);
  const at = src.indexOf(constName);
  expect(at, `${constName} moved or was renamed`).toBeGreaterThan(-1);
  return [...src.slice(at, src.indexOf('];', at)).matchAll(/^\s*'([a-z_.]+)',/gm)]
    .map((m) => m[1]!);
};

const allBroadcastKinds = (): string[] => {
  const src = repoFile('../../../../packages/contracts/src/events.ts');
  const at = src.indexOf('ALL_BROADCAST_EVENT_KINDS = [');
  expect(at, 'ALL_BROADCAST_EVENT_KINDS moved').toBeGreaterThan(-1);
  return [...src.slice(at, src.indexOf('] as const', at)).matchAll(/^\s*'([a-z_.]+)',/gm)]
    .map((m) => m[1]!);
};

/** Kinds that appear inside an `.emit({ … })` call in server source.
 *
 *  ⚠ EMIT SITES, NOT LITERALS. `kind: 'notification'` also names a CONNECTION
 *  ROW (`connectionStore.list({ kind: 'notification' })`), so a bare literal
 *  sweep reports a kind as emitted when nothing puts it on a bus — which would
 *  have hidden the very bug this file exists for.
 *
 *  ⚠ AND IT READS FILES, NOT `grep -o`. The first version of this used a
 *  line-oriented grep and silently saw only SINGLE-LINE emits — every
 *  `bus.emit({\n  kind: …` in the codebase was invisible to it. The
 *  known-positive test below caught that immediately, which is the entire reason
 *  it is written before the assertion it guards. */
const emittedKinds = (): Set<string> => {
  const root = new URL('../../../../', import.meta.url).pathname;
  const files = execFileSync(
    'grep',
    [
      '-rl', '--include=*.ts', '-e', '.emit(',
      '--exclude-dir=dist', '--exclude-dir=__tests__',
      'backend/server/src', 'packages',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: root },
  ).split('\n').filter(Boolean);

  const found = new Set<string>();
  for (const rel of files) {
    // ⚠ COMMENTS STRIPPED, AND `dist` + tests EXCLUDED. Four of the first run's
    // hits were PROSE — doc comments quoting `.emit({ kind: 'notification' })`
    // while describing the very behaviour that had just been removed — plus a
    // build artifact carrying the same stale text. A sweep that reads
    // documentation reports a kind as live because someone wrote about it.
    const src = stripComments(readFileSync(`${root}${rel}`, 'utf-8'));
    for (const m of src.matchAll(/\.emit\(\s*\{/g)) {
      // The kind is the first such key inside the object literal; 400 chars is
      // comfortably past it for every emit in this codebase.
      const window = src.slice(m.index!, m.index! + 400);
      const kind = window.match(/kind: '([a-z_.]+)'/);
      if (kind) found.add(kind[1]!);
    }
  }
  return found;
};

describe('broadcast reachability — nothing is emitted into the void', () => {
  /** ⛔⛔ VALIDATE THE DETECTOR AGAINST KNOWN POSITIVES FIRST. A source sweep
   *  reads the same whether a thing is absent or merely spelled differently, so
   *  an empty result proves nothing until the method is shown able to SEE. The
   *  same discipline the D-228 removal note used on its own zero. */
  it('the emit-site sweep can actually see emitted kinds', () => {
    const emitted = emittedKinds();
    expect(emitted.size, 'the sweep found nothing at all — the idiom changed').toBeGreaterThan(10);
    for (const known of ['approval', 'execution', 'notification.notify']) {
      expect(emitted.has(known), `sweep missed a kind known to be emitted: ${known}`).toBe(true);
    }
  });

  it('every emitted broadcast kind is named by a client, or declared unfanned', () => {
    const all = new Set(allBroadcastKinds());
    const subscribed = new Set([
      ...namedIn('../../../../apps/webclient/src/realtime/subscriber.ts', 'WEBCLIENT_DEFAULT_SUBSCRIPTIONS'),
      ...namedIn('../../../../apps/bridge/src/realtime/subscriber.ts', 'BRIDGE_DEFAULT_SUBSCRIPTIONS'),
    ]);
    const declared = new Set(DELIBERATELY_UNFANNED.map((e) => e.kind));

    const stranded = [...emittedKinds()]
      .filter((k) => all.has(k))
      .filter((k) => !subscribed.has(k) && !declared.has(k))
      .sort();

    expect(
      stranded,
      'these kinds are put on the bus and named by NO client, so the fan-out '
      + 'drops them — emitters count them as delivered and nobody hears. Either '
      + 'add the kind to a client subscription list, or declare it in '
      + 'DELIBERATELY_UNFANNED with a reason',
    ).toEqual([]);
  });

  /** ⚠ AND THE EXCEPTION LIST MUST NOT ROT. A kind that became subscribed, or
   *  stopped being emitted, should leave the list rather than sit there implying
   *  a decision nobody is making any more. */
  it('every declared exception is still emitted and still unsubscribed', () => {
    const emitted = emittedKinds();
    const subscribed = new Set([
      ...namedIn('../../../../apps/webclient/src/realtime/subscriber.ts', 'WEBCLIENT_DEFAULT_SUBSCRIPTIONS'),
      ...namedIn('../../../../apps/bridge/src/realtime/subscriber.ts', 'BRIDGE_DEFAULT_SUBSCRIPTIONS'),
    ]);
    for (const { kind } of DELIBERATELY_UNFANNED) {
      expect(emitted.has(kind), `${kind} is no longer emitted — drop the exception`).toBe(true);
      expect(
        subscribed.has(kind),
        `${kind} is now subscribed — drop the exception, it is no longer unfanned`,
      ).toBe(false);
    }
  });
});
