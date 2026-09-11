import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { simulateRecipe } from '@recued/engine';
import type { RecipeDefinition } from '@recued/contracts';
import { makeRecipeSimulationHandlers } from '../recipe-simulation-handler.js';
import type { WsClient } from '../ws-server.js';

vi.mock('@recued/engine', () => ({ simulateRecipe: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['disconnect', 'deadline'] as const)('stops a server-side sample on %s and releases its connection slot', async reason => {
  vi.useFakeTimers();
  const socket = new EventEmitter();
  const client: WsClient = { ws: socket, realm: 'test', instance_id: 'owner', client_kind: 'webclient', display_name: 'Owner', connected_at: 1 };
  const recipe: RecipeDefinition = { recipe_id: 'sample', version: 1, ttl: 0,
    metadata: { name: 'Sample', description: 'Sample test.', author: 'owner', supported_platforms: [] },
    variables: {}, steps: [{ id: 'count', transform: 'count', input: [] }], prefetch_steps: [], output: { render: [] },
  };
  vi.mocked(simulateRecipe).mockImplementationOnce((_recipe, _sample, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  const handlers = makeRecipeSimulationHandlers().handlers;
  const pending = handlers['recipe.simulate']({ recipe, sample: {}, simulation_id: 'first' }, client);
  const rejected = expect(pending).rejects.toMatchObject({ code: reason === 'disconnect' ? 'cancelled' : 'timeout' });
  if (reason === 'disconnect') socket.emit('close');
  else await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(socket.listenerCount('close')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.mocked(simulateRecipe).mockResolvedValueOnce({ status: 'passed', steps: [] });
  await expect(handlers['recipe.simulate']({ recipe, sample: {}, simulation_id: 'second' }, client))
    .resolves.toEqual({ status: 'passed', steps: [] });
});
