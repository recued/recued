/** Types for the version stamper's exported helpers. The implementation is plain
 *  `.mjs` because the release tooling runs as scripts with no build step of their
 *  own; this declaration exists so the release driver and the rollout-policy
 *  ratchet in `test/` can be typechecked against them.
 *
 *  ⚠ ONLY THE HELPERS ARE EXPORTED. Everything that stamps is inside the module's
 *  CLI guard, so importing this file reads a version and computes a target and
 *  writes nothing — see the guard's own comment for why that matters. */

/** Every file whose recued-server version must equal package.json's. */
export declare const VERSION_STAMPED_FILES: readonly string[];

/** The anchored forms that name a recued-server version inside a stamped file. */
export declare const VERSION_ANCHORS: readonly RegExp[];

/** The version a file currently carries: `null` when no anchor matches, and a
 *  THROW when anchors disagree (a file naming two versions cannot be swapped). */
export declare const detectVersion: (text: string, rel: string) => string | null;

/** A stamped file's declared version, read from TEXT so a caller can hand it a
 *  blob from any commit rather than only the working tree. */
export declare const stampedVersionOf: (rel: string, text: string) => string | null;

/** Why stamping `target` over `current` would go backwards, or `null` when it is
 *  safe. A target lower than the current stamp is never an update to anybody. */
export declare const downgradeRefusal: (target: string, current: string) => string | null;
