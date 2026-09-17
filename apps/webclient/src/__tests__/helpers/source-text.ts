/** Read a source file with its COMMENTS REMOVED, for guards that assert on code.
 *
 *  ⛔⛔ WHY THIS EXISTS. A source-reading guard that matches raw text cannot tell
 *  a CALL from a SENTENCE ABOUT a call, and in one review that mistake was made
 *  six separate times:
 *
 *    · `toContain('serverAddressDeps')` passed against `xserverAddressDepsx`;
 *    · `toContain('unloadWouldLoseWork')` passed against
 *      `unloadWouldLoseWork: false`;
 *    · `.includes('onLegacyAadRecord')` decided the hook was WIRED because
 *      another file MENTIONED IT IN A COMMENT saying it was not — leaving the
 *      whole ratchet inert while passing;
 *    · `toContain('decideAddressChangeConvergence')` passed with the policy
 *      inlined and the name left in a comment;
 *    · `toContain('activeProfileId:')` passed against
 *      `// activeProfileId: dropped on purpose`;
 *    · `toContain('buildAadBytesV1')` survived deleting the function, because
 *      the call site kept the name.
 *
 *  🔑 Every one of those is the same defect: THE GUARD SEARCHED THE PROSE IT WAS
 *  WRITTEN ALONGSIDE. Explaining a rule in a comment is exactly what makes the
 *  rule's own guard pass — so the more carefully a change is documented, the
 *  more likely it is to defeat the check. Stripping comments first removes the
 *  failure mode rather than the fifth instance of it.
 *
 *  ⚠ STILL NOT A PARSER. It removes `//` and block comments and is blind to
 *  those sequences inside string literals, which is acceptable for asserting on
 *  code shape and is not acceptable for anything load-bearing at runtime.
 */

import { readFileSync } from 'node:fs';

export const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The file's CODE, comments removed. */
export const codeOf = (path: string): string =>
  stripComments(readFileSync(path, 'utf-8'));

/** A window of code around an anchor — comments already gone, so an offset is
 *  measured in code rather than in documentation.
 *
 *  ⛔ THROWS WHEN THE ANCHOR IS GONE, AND THAT IS THE WHOLE DESIGN. A first
 *  version returned `''`, which every POSITIVE assertion catches and every
 *  NEGATIVE one passes: `expect('').not.toMatch(/anything/)` is green. So a
 *  guard would keep passing after the code it watches was renamed out from
 *  under it — the same "absence read as success" that made a mutation harness
 *  report a broken scan as perfect coverage earlier in this review.
 *
 *  ⚠ Today's callers all pair it with a positive assertion and would have been
 *  fine. This is for the next one, who will not know that they had to. */
export const codeNear = (path: string, anchor: string, span = 800): string => {
  const code = codeOf(path);
  const at = code.indexOf(anchor);
  if (at < 0) {
    throw new Error(
      `source-text: anchor ${JSON.stringify(anchor)} is not in ${path} (as CODE — it may still exist in a comment). `
      + 'The guard that asked for it is watching something that moved; re-point it rather than deleting it.',
    );
  }
  return code.slice(at, at + span);
};
