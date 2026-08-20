/** D-160 P1 — the middleware registry (§ N.3).
 *
 *  The registry records `(id → Middleware, enabled)` and is the
 *  framework's *single* enable mechanism. The pipeline iterates
 *  `enabled()` at each lifecycle hook — a disabled middleware is never
 *  consulted.
 *
 *  The registry has no per-component special-casing: "is component X
 *  enabled" is always "is the X middleware enabled" — one uniform
 *  mechanism, no special gate (N.3 / I-8).
 *
 *  Registration order is preserved — `enabled()` and `all()` return
 *  middlewares in the order they registered, so a deployment's hook
 *  ordering is the registration ordering, deterministic and legible.
 *
 *  Whether the enabled state is keyed per-policy-cell or global is
 *  D-160 O-2 — open. The registry's *shape* (id-keyed, enabled-flagged)
 *  is normative regardless; a registry instance is per-call here.
 *
 *  **Internal-only, dynamic count (D-164 amendment).** The registry is
 *  an *internal* substrate — it has no public extension surface and no
 *  pinned count of middlewares. D-160 P2's six-middleware enumeration
 *  (`two-stage`, `confidence-shape`, `standing-instructions`,
 *  `correction-learning`, `scope-search`, `personal-recipes`) is
 *  superseded by D-164. As of D-164 P6, the consolidated layout has
 *  the registry carry one enabled entry (`prompt-cache`); the
 *  previously-registered disabled `cognition` slot was retired by
 *  **D-164 P6's chat rewrite**, which absorbed the orchestrator +
 *  every cognition consumer in one pass. The registry's *shape* makes no claim about
 *  count regardless — a deployment registers whatever set of
 *  middlewares the boot wiring composes; the registry is the seam,
 *  never a closed list. The `register()` method's "throws on duplicate
 *  id" remains the only hard constraint; there is no per-id allow-list.
 *
 *  Spec: D-160 § N.3 / A.3 +
 *  D-164 P5
 *  (registry-role clarification).
 */

import type { Middleware } from './types.js';

/** One registry entry — a middleware plus its enabled state. */
export interface MiddlewareEntry {
  readonly middleware: Middleware;
  readonly enabled: boolean;
}

/** The middleware registry. */
export interface MiddlewareRegistry {
  /** Register a middleware. Enabled by default; pass
   *  `{ enabled: false }` to register a slot disabled. Throws on a
   *  duplicate id — a registry must not silently shadow a middleware. */
  register(middleware: Middleware, options?: { enabled?: boolean }): void;
  /** Enable a registered middleware. Throws on an unknown id. */
  enable(id: string): void;
  /** Disable a registered middleware. Throws on an unknown id. */
  disable(id: string): void;
  /** Whether a registered middleware is enabled. Throws on an unknown
   *  id — "is X enabled" is undefined for an X that was never
   *  registered, and a silent `false` would hide the typo. */
  isEnabled(id: string): boolean;
  /** Whether an id is registered (in any enabled state). */
  has(id: string): boolean;
  /** The enabled middlewares, in registration order — exactly what the
   *  pipeline iterates at each lifecycle hook. */
  enabled(): readonly Middleware[];
  /** Every registered entry, in registration order — a registry audit
   *  surface (e.g. asserting a slot reports disabled at boot). */
  all(): readonly MiddlewareEntry[];
}

/** Create an empty middleware registry. */
export const createMiddlewareRegistry = (): MiddlewareRegistry => {
  // A Map preserves insertion order — registration order is hook order.
  const entries = new Map<string, { middleware: Middleware; enabled: boolean }>();

  const requireEntry = (
    id: string,
  ): { middleware: Middleware; enabled: boolean } => {
    const entry = entries.get(id);
    if (entry === undefined) {
      throw new Error(`middleware registry: unknown middleware id '${id}'`);
    }
    return entry;
  };

  return {
    register(middleware: Middleware, options?: { enabled?: boolean }): void {
      if (entries.has(middleware.id)) {
        throw new Error(
          `middleware registry: id '${middleware.id}' is already registered`,
        );
      }
      entries.set(middleware.id, {
        middleware,
        enabled: options?.enabled ?? true,
      });
    },
    enable(id: string): void {
      requireEntry(id).enabled = true;
    },
    disable(id: string): void {
      requireEntry(id).enabled = false;
    },
    isEnabled(id: string): boolean {
      return requireEntry(id).enabled;
    },
    has(id: string): boolean {
      return entries.has(id);
    },
    enabled(): readonly Middleware[] {
      const out: Middleware[] = [];
      for (const entry of entries.values()) {
        if (entry.enabled) out.push(entry.middleware);
      }
      return out;
    },
    all(): readonly MiddlewareEntry[] {
      return [...entries.values()].map((entry) => ({
        middleware: entry.middleware,
        enabled: entry.enabled,
      }));
    },
  };
};
