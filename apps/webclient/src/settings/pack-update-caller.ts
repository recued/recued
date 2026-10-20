import type { Conn, ServerRpcRegistry, PackUpdateStage, PackUpdateView, PackUpdateTest, PackUpdateTestResult, PackUpdateApply, PackUpdateApplyResult, PackUpdateRelease, PackRestoreStage } from '@recued/contracts';
export interface PackUpdateCaller {
  restore(args: PackRestoreStage): Promise<PackUpdateView>;
  release(args: PackUpdateRelease): Promise<PackUpdateView>;
  apply(args: PackUpdateApply): Promise<PackUpdateApplyResult>;
  get(args: { pack_slug: string }): Promise<PackUpdateView>;
  stage(args: PackUpdateStage): Promise<PackUpdateView>;
  test(args: Omit<PackUpdateTest,'run_id'>, signal: AbortSignal): Promise<PackUpdateTestResult>;
}
export const createPackUpdateCaller = (call: Conn<ServerRpcRegistry>): PackUpdateCaller => ({
  restore: args => call('packs.update.restore',args),
  release: args => call('packs.update.release',args),
  apply: args => call('packs.update.apply',args,{ timeout: 65_000 }),
  get: args => call('packs.update.get',args),
  stage: args => call('packs.update.stage',args),
  async test(args,signal) {
    signal.throwIfAborted(); const run_id = crypto.randomUUID();
    const cancel = (): void => { void call('recipe.regression.cancel',{ run_id }).catch(() => {}); };
    signal.addEventListener('abort',cancel,{ once: true });
    try { return await call('packs.update.test',{ ...args,run_id },{ signal,timeout: 65_000 }); }
    finally { signal.removeEventListener('abort',cancel); }
  },
});
