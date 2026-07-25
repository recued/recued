/** D-149 P2 § A.5 — shared types for per-kind reception handlers.
 *
 *  Each handler is invoked once the path-routing dispatcher has
 *  matched `/reception/<kind>/...` AND the registry lookup has
 *  authorized the request (token validated; rate limit cleared).
 *  P2 ships the handler signature + the stub bodies; P3 wires the
 *  registry; P4-P9 fill the per-kind logic.
 *
 *  Handlers MUST NOT import from `packages/engine/` or
 *  `packages/recipes/` (Must Hold I-12 + role-boundary lint at
 *  `__tests__/d-149-phase-1-reception-role-boundary.test.ts`). The
 *  request thread persists to the per-row reception tables only;
 *  engine reaction fires async via reactive triggers (D-115). */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReceptionEndpointContext } from '../redacted-packet.js';

/** Per-kind handler shape. Closed signature so the dispatcher table
 *  can hold one shape regardless of kind. */
export type ReceptionKindHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: ReceptionEndpointContext,
) => Promise<void>;
