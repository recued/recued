/** Am I the single-executable build?
 *
 *  ⛔ ASK `node:sea`, NEVER INFER IT. Two things that look like they answer this
 *  question do not:
 *
 *    · `process.execPath` — in a SEA it is the recued binary, but from a source
 *      checkout or an npm install it is the owner's `node`. Code that assumes
 *      the first ends up treating `/opt/homebrew/.../bin/node` as Recued.
 *    · `RECUED_DISTRIBUTION_CHANNEL` — defaults to `binary` when unset, so it
 *      reports "packaged" on every non-packaged install.
 *
 *  `sea.isSea()` asks the runtime directly and is right in all four cases
 *  (SEA, source, npm, docker-thin).
 *
 *  ⚠ THE `require` HERE IS SAFE AND THE DISTINCTION MATTERS. A runtime
 *  `require` of a *bundled dependency* is what took `/ws` off the air for six
 *  weeks — esbuild cannot see through it, so nothing was inlined and the
 *  packaged binary reached for a `node_modules` that does not exist. `node:sea`
 *  is a BUILTIN: it is never bundled, it is resolved by node itself, and it is
 *  the one form the SEA-visible-require ratchet deliberately allows. */
export const runningAsPackagedBinary = (): boolean => {
  try {
    if (typeof require === 'undefined') return false;
    const sea = require('node:sea') as { isSea(): boolean };
    return sea.isSea();
  } catch {
    // `node:sea` absent (older base) — then this is not a SEA either.
    return false;
  }
};
