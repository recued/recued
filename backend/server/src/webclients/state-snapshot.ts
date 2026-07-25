/** D-148 § A.4.2 — server-side `state.snapshot` rpc dispatcher.
 *
 *  Per-surface state hydration. The webclient calls
 *  `state.snapshot('inbox')` (or any other surface in
 *  `WEBCLIENT_SNAPSHOT_SURFACES`); the dispatcher routes to the
 *  registered projection for that surface. Each projection is a
 *  pure function: server inputs → typed `WebclientStateSnapshot`.
 *
 *  No client-side merge logic per § A.4.2 line 534 — the snapshot is
 *  the truth. Broadcast events apply edits on top; full-resync goes
 *  back through this dispatcher.
 *
 *  P4 substrate: dispatcher + per-surface stub projections that
 *  return inert defaults. P5+ wires the concrete projections from
 *  the warehouse + approval store + exposure state machine + key
 *  health bundle. The dispatcher itself stays stable.
 */

import {
  isWebclientSnapshotSurface,
  type WebclientSnapshotSurface,
  type WebclientStateSnapshot,
} from '@recued/contracts';

export type StateSnapshotProjection<S extends WebclientSnapshotSurface = WebclientSnapshotSurface> =
  (args: { client_token_id: string; cursor?: number; now?: number }) => Promise<
    Extract<WebclientStateSnapshot, { surface: S }>
  >;

export interface StateSnapshotDispatcher {
  /** Register a projection for a given surface. Idempotent — re-
   *  registering replaces the prior projection (test surfaces
   *  override the production projection). */
  register<S extends WebclientSnapshotSurface>(
    surface: S,
    projection: StateSnapshotProjection<S>,
  ): void;
  /** Dispatch a snapshot request. Returns the projected
   *  `WebclientStateSnapshot` or throws when the surface is unknown. */
  dispatch(
    surface: string,
    args: { client_token_id: string; cursor?: number; now?: number },
  ): Promise<WebclientStateSnapshot>;
  /** List registered surfaces — used by the rpc handshake +
   *  diagnostics. */
  registered(): WebclientSnapshotSurface[];
}

export class StateSnapshotSurfaceUnknownError extends Error {
  readonly code = 'state_snapshot_surface_unknown' as const;
  constructor(public readonly attempted: string) {
    super(`state.snapshot: unknown surface '${attempted}'`);
  }
}

export class StateSnapshotProjectionMissingError extends Error {
  readonly code = 'state_snapshot_projection_missing' as const;
  constructor(public readonly surface: WebclientSnapshotSurface) {
    super(`state.snapshot: no projection registered for '${surface}'`);
  }
}

export const createStateSnapshotDispatcher = (): StateSnapshotDispatcher => {
  const registry = new Map<WebclientSnapshotSurface, StateSnapshotProjection>();
  return {
    register(surface, projection) {
      registry.set(surface, projection as unknown as StateSnapshotProjection);
    },
    async dispatch(surface, args) {
      if (!isWebclientSnapshotSurface(surface)) {
        throw new StateSnapshotSurfaceUnknownError(surface);
      }
      const projection = registry.get(surface);
      if (!projection) {
        throw new StateSnapshotProjectionMissingError(surface);
      }
      return projection(args);
    },
    registered() {
      return [...registry.keys()];
    },
  };
};

/** Default-empty projections useful for tests + the cold-boot path
 *  before per-surface projections are wired. Each returns the typed
 *  empty shape with `cursor: 0`. */
export const buildDefaultEmptyProjection = <S extends WebclientSnapshotSurface>(
  surface: S,
): StateSnapshotProjection<S> => {
  return async (): Promise<Extract<WebclientStateSnapshot, { surface: S }>> => {
    let snapshot: WebclientStateSnapshot;
    if (surface === 'inbox') {
      snapshot = {
        surface: 'inbox',
        pending_approvals: [],
        recent_reactive_fires: [],
        cursor: 0,
      };
    } else if (surface === 'settings.connections') {
      snapshot = {
        surface: 'settings.connections',
        connections: [],
        cursor: 0,
      };
    } else if (surface === 'settings.exposure') {
      snapshot = {
        surface: 'settings.exposure',
        derived_preset_label: 'lan_only',
        resolution: {
          health: { lan: true, public: false },
          ws: { lan: true, public: false },
          mcp: { lan: true, public: false },
          llm_gateway: { lan: true, public: false },
          webhooks: { lan: false, public: false },
          reception: { lan: false, public: false },
          oauth: { lan: false, public: false },
          ask: { lan: false, public: false },
          webclient: { lan: true, public: false },
        },
        public_mcp_acknowledged: false,
        cursor: 0,
      };
    } else if (surface === 'settings.key_health') {
      snapshot = {
        surface: 'settings.key_health',
        key_health: {},
        cursor: 0,
      };
    } else if (surface === 'internal_steps') {
      snapshot = {
        surface: 'internal_steps',
        runs: [],
        cursor: 0,
      };
    } else {
      throw new Error(`buildDefaultEmptyProjection: unhandled surface '${String(surface)}'`);
    }
    return snapshot as Extract<WebclientStateSnapshot, { surface: S }>;
  };
};
