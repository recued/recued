import type { Conn, RecipeSimulationRequest, RecipeSimulationResult, ServerRpcRegistry } from '@recued/contracts';

export type RecipeSimulationCaller = (
  args: Omit<RecipeSimulationRequest, 'simulation_id'>, signal: AbortSignal,
) => Promise<RecipeSimulationResult>;

/** Cancellation releases both the browser waiter and its server-side test. */
export const createRecipeSimulationCaller = (call: Conn<ServerRpcRegistry>): RecipeSimulationCaller =>
  async (args, signal) => {
    signal.throwIfAborted();
    const simulation_id = crypto.randomUUID();
    const cancel = (): void => { void call('recipe.simulate.cancel', { simulation_id }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      return await call('recipe.simulate', { ...args, simulation_id }, { signal, timeout: 35_000 });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };
