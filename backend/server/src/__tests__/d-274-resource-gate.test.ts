// D-274 slice 3 — the gate flip.
//
// Before this D, `buildForegroundMonitor` returned `undefined` for a binding
// that declared no `progress`, and the caller's `if (monitor)` put BOTH the
// auto-kill arm and the attended flag arm behind it. 455 of 457 shipped cli ops
// declare nothing, so the whole live-control apparatus was dark for them.
//
// These drive the REAL executor with REAL child processes.

import { describe, expect, it } from 'vitest';
import { createCliInvocationExecutor } from '../cli-invocation-executor.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

const registryWithRun = (run_id: string): InFlightRegistry => {
  const registry = new InFlightRegistry(new LaneSemaphore());
  registry.registerRun({
    run_id,
    recipe_id: `recipe-${run_id}`,
    source: { channel: 'user', actor: 'user_self', user_id: 'u1', client_token_id: 'client1' },
    origin: 'attended',
    session_id: 'client1',
    started_at: 1,
    abort: () => {},
  });
  return registry;
};

describe('D-274 — an UNDECLARED cli binding now gets a resource contract', () => {
  it('reports progress.contract = "resource" for a binding that declares nothing', async () => {
    const registry = registryWithRun('run-undeclared');
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      stallTuning: { pollMs: 10, resourceSampleMs: 0 },
    });

    await exec({
      slug: 'gs-like',
      operation_key: 'pdf.compress',
      operation_id: 'recued-core/pdf.compress',
      args: {},
      timeout_ms: 5_000,
      stepMeta: { run_id: 'run-undeclared', step_id: 'compress', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        // burns CPU briefly, then exits — the ordinary shape of the 455
        argv_template: [process.execPath, '-e', 'const t=Date.now();while(Date.now()-t<300){Math.sqrt(Math.random());}'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        // ⛔ NO `progress` key — that is the whole point of the case
      },
    });

    const progress = registry.snapshot('client1').entries[0]?.progress;
    expect(progress?.contract).toBe('resource');
    expect(progress?.last_signal_at).toEqual(expect.any(Number));
    expect(progress?.stalled).toBe(false);
  }, 20_000);

  it('⛔ FLAGS an idle tree and leaves it RUNNING — report, never kill', async () => {
    // The load-bearing assertion is not "it flagged" but "it flagged AND the op
    // still completed". A monitor that killed would surface the same flag.
    //
    // ⚠ THE SAMPLER IS INJECTED, AND THAT IS THE POINT. An earlier version ran a
    // real `ps -A` and needed two samples to land inside the child's 1.2s life.
    // It passed in isolation and failed inside the FULL SUITE (`--maxWorkers 2`,
    // 3813 files), where a `ps` takes as long as it takes — so the test was
    // asserting physics it did not control, and no number of isolated reruns
    // could show that. A frozen sample makes the tree unambiguously still; the
    // question of whether a REAL still tree reads as still is answered
    // deterministically in `resource-progress-source.test.ts`.
    const frozen = { cpu_ms: 1_000, rss_bytes: 10_000, pids: 1 };
    const registry = registryWithRun('run-idle');
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      stallTuning: {
        pollMs: 10,
        resourceSampleMs: 0,
        resourceMinComparisonMs: 0,    // the frozen sampler needs no window
        resourceSampler: async () => frozen,
        expectedIntervalMs: 40,        // k * T ⇒ flag fast
        factorK: 2,
      },
    });

    // ⚠ NO WATCHER. The flag is only cleared by `reportProgress` (a real progress
    // signal, which a frozen sampler never produces) or by `completeRun`, which
    // the cli executor never calls — the executor's only mention of it is a
    // comment. So the flag SURVIVES the run and can be asserted afterwards.
    // Polling for it mid-run made the assertion depend on a setInterval getting
    // scheduled inside the child's lifetime, which is exactly what fails under a
    // full-suite run and passes in isolation.
    //
    // Alive for ~1.2s while consuming essentially no CPU: the wedged signature.
    const result = await exec({
      slug: 'wedged',
      operation_key: 'op.idle',
      operation_id: 'recued-core/op.idle',
      args: {},
      timeout_ms: 20_000,
      stepMeta: { run_id: 'run-idle', step_id: 'idle', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'setTimeout(()=>{process.stdout.write("done");process.exit(0);},1200);'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });

    expect(registry.snapshot('client1').entries[0]?.progress?.stalled).toBe(true); // surfaced
    expect(result).toMatchObject({ exit_code: 0, stdout: 'done' });                // ⇒ NOT killed
  }, 30_000);

  it('never flags a run SHORTER than one comparison window (the production floor)', async () => {
    // ⚠ THIS TEST USED TO SPIN A CHILD AND ASSERT "a working tree is not
    // flagged", AND IT FLAKED UNDER LOAD — correctly. `ps` reports 10ms steps,
    // so over the ~40ms gaps that `resourceSampleMs: 0` produces, a child
    // pegging a core can read ZERO (measured: 0-20ms per gap at load 45). That
    // is not a test bug, it is the detector being asked a question the window
    // cannot answer — which is why MIN_COMPARISON_MS now exists.
    //
    // At the production floor the property is DETERMINISTIC and worth pinning:
    // a run that does not span one comparison window can never be flagged,
    // whatever the CPU does. The epsilon logic itself is covered against an
    // injected sampler in resource-progress-source.test.ts.
    const registry = registryWithRun('run-busy');
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      // no resourceMinComparisonMs override => the real 5s floor
      stallTuning: { pollMs: 10, resourceSampleMs: 0, expectedIntervalMs: 40, factorK: 2 },
      // (sampler left real: this case asserts the FLOOR, which holds whatever
      //  the sampler returns, so it cannot be timing-sensitive either way)
    });

    // A MOVING sampler: cpu advances every call, so the tree is unambiguously
    // busy without depending on a real process getting scheduled.
    let cpu = 1_000;
    let flagged = false;
    const watcher = setInterval(() => {
      if (registry.snapshot('client1').entries[0]?.progress?.stalled === true) flagged = true;
    }, 25);

    await exec({
      slug: 'busy',
      operation_key: 'op.busy',
      operation_id: 'recued-core/op.busy',
      args: {},
      timeout_ms: 20_000,
      stepMeta: { run_id: 'run-busy', step_id: 'busy', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'const t=Date.now();while(Date.now()-t<1200){Math.sqrt(Math.random());}process.stdout.write("done");'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });
    clearInterval(watcher);
    expect(flagged).toBe(false);
  }, 30_000);

  it('⛔ L1 — a long idle op is NOT killed by the wall-clock cap', async () => {
    // `SILENT_OP_HARD_CAP_MS` (30 min) kills an ATTENDED run too, so the naive
    // resource wiring would SIGKILL whisper (authored 4h) at minute 30. Driven
    // by shrinking the cap to 50ms and running well past it.
    //
    // ⚠ WHAT THIS ACTUALLY PINS, verified by mutation: `flagOnly`. Removing the
    // constructor's `silentHardCapMs: Infinity` alone leaves this GREEN, because
    // `flagOnly` already forces `stalled = false` — the two guards are redundant
    // and only one is reachable. This test goes red when `flagOnly` is dropped.
    // It is named for the user-visible property (a long idle op survives), not
    // for whichever guard currently delivers it.
    const registry = registryWithRun('run-cap');
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      stallTuning: { pollMs: 10, resourceSampleMs: 0, silentHardCapMs: 50 },
    });

    const result = await exec({
      slug: 'longrunner',
      operation_key: 'audio.transcribe',
      operation_id: 'recued-core/audio.transcribe',
      args: {},
      timeout_ms: 20_000,
      stepMeta: { run_id: 'run-cap', step_id: 'transcribe', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'setTimeout(()=>{process.stdout.write("survived");process.exit(0);},800);'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });
    expect(result).toMatchObject({ exit_code: 0, stdout: 'survived' });
  }, 30_000);

  it('an EXPLICIT declaration still wins over the implicit default', async () => {
    const registry = registryWithRun('run-declared');
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      stallTuning: { pollMs: 10, resourceSampleMs: 0 },
    });

    await exec({
      slug: 'codex-pack',
      operation_key: 'codex.review',
      operation_id: 'recued-core/codex.review',
      args: {},
      timeout_ms: 5_000,
      stepMeta: { run_id: 'run-declared', step_id: 'review', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [
          process.execPath, '-e',
          'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"1"}})+"\\n")',
        ],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
        progress: { contract: 'heartbeat', adapter: 'codex-jsonl', stall_ms: 500 },
      },
    });

    expect(registry.snapshot('client1').entries[0]?.progress?.contract).toBe('heartbeat');
  }, 20_000);
});

describe('D-274 §8 — the per-op clock on the active list', () => {
  it('reports current_op with the op key and ITS OWN start, distinct from the run clock', async () => {
    const registry = registryWithRun('run-clock');
    // The run registered with started_at: 1 (epoch-ish). The op starts NOW, so a
    // shared clock would be indistinguishable from the run's — asserting they
    // differ is what proves this is a second clock and not the same one relabelled.
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      stallTuning: { pollMs: 10, resourceSampleMs: 0 },
    });

    let seen: { op: string; started_at: number; pid: number } | undefined;
    const watcher = setInterval(() => {
      const e = registry.snapshot('client1').entries[0];
      if (e?.current_op) seen = e.current_op;
    }, 20);

    await exec({
      slug: 'ffmpeg',
      operation_key: 'media.transcode',
      operation_id: 'recued-core/media.transcode',
      args: {},
      timeout_ms: 20_000,
      stepMeta: { run_id: 'run-clock', step_id: 'transcode', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        // ⚠ 1500ms, not 500: the watcher must get several ticks INSIDE the child's
      // life, and under a full-suite run (`--maxWorkers 2`, 3813 files) a
      // setInterval can be delayed well past a 500ms window. Widening the window
      // is the fix; the assertion itself is about the projection, not the clock.
      argv_template: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),1500);'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });
    clearInterval(watcher);

    expect(seen?.op).toBe('media.transcode');
    expect(seen?.pid).toEqual(expect.any(Number));
    expect(seen?.started_at).toBeGreaterThan(1);   // ⇒ NOT the run's started_at
  }, 20_000);

  it('omits current_op once the child detaches', async () => {
    const registry = registryWithRun('run-detach');
    const exec = createCliInvocationExecutor({
      inFlightRegistry: registry,
      stallTuning: { pollMs: 10, resourceSampleMs: 0 },
    });
    await exec({
      slug: 'ffmpeg',
      operation_key: 'media.transcode',
      operation_id: 'recued-core/media.transcode',
      args: {},
      timeout_ms: 20_000,
      stepMeta: { run_id: 'run-detach', step_id: 'transcode', trigger_source: 'chat' },
      binding: {
        kind: 'cli_invocation',
        argv_template: [process.execPath, '-e', 'process.exit(0)'],
        shape: 'text',
        exit_code_handling: 'zero_is_success',
      },
    });
    // A stale op clock left behind after the child settled would read as a live
    // op forever — the opposite failure from having no clock at all.
    expect(registry.snapshot('client1').entries[0]?.current_op).toBeUndefined();
  }, 20_000);
});
