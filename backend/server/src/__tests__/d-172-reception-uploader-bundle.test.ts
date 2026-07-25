/** D-172 step 5b/5c — reception uploader bundle invariants guard.
 *
 *  The reception uploader ships as a COMMITTED generated artifact
 *  (`drop-uploader-bundle.generated.ts`, built by
 *  `scripts/build-reception-uploader.mjs`). This guards the properties that
 *  matter — so a forgotten regenerate or a leaked import is caught — WITHOUT a
 *  byte-exact fresh-build compare (which would be flaky across the `^esbuild`
 *  patch range):
 *
 *   1. The served `drop-uploader.js` static-asset bytes ARE the generated
 *      constant, and its SRI is recomputed from exactly those bytes (so the
 *      page's `integrity=` can never drift from the served file).
 *   2. WS-FREE — the whole point of the D-172 transport seam: the reception
 *      (HTTP) bundle must NOT carry the binary `/ws/upload` framing /
 *      `encodeUploadChunkFrame` / the `@recued/contracts` barrel.
 *   3. The reception client really is in there (not an empty/stub bundle).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  RECEPTION_DROP_UPLOADER_JS,
  RECEPTION_DROP_UPLOADER_SHA384_AT_BUILD,
} from '../ports/reception/drop-uploader-bundle.generated.js';
import {
  RECEPTION_DROP_UPLOADER_SRC,
  RECEPTION_DROP_UPLOADER_SRI,
  lookupReceptionStaticAsset,
} from '../ports/reception/static-assets.js';

describe('D-172 reception uploader bundle — SRI / asset consistency', () => {
  const servedBytes = Buffer.from(RECEPTION_DROP_UPLOADER_JS, 'utf8');

  it('the SRI is recomputed from the served bytes (no drift)', () => {
    const expected = `sha384-${createHash('sha384').update(servedBytes).digest('base64')}`;
    expect(RECEPTION_DROP_UPLOADER_SRI).toBe(expected);
  });

  it('the recomputed SRI matches the build-time hash (regenerate-on-change held)', () => {
    expect(RECEPTION_DROP_UPLOADER_SRI).toBe(`sha384-${RECEPTION_DROP_UPLOADER_SHA384_AT_BUILD}`);
  });

  it('the static dispatcher serves exactly those bytes as JS', () => {
    const asset = lookupReceptionStaticAsset('/reception/_static/drop-uploader.js');
    expect(asset).not.toBeNull();
    expect(asset!.content_type).toContain('javascript');
    expect(asset!.bytes.equals(servedBytes)).toBe(true);
  });

  it('the content-addressed src points at the served asset', () => {
    expect(RECEPTION_DROP_UPLOADER_SRC).toMatch(
      /^\/reception\/_static\/drop-uploader\.js\?v=[a-f0-9]{12}$/,
    );
  });
});

describe('D-172 reception uploader bundle — transport-seam invariants', () => {
  it('is non-trivial (the reception client is actually bundled)', () => {
    expect(RECEPTION_DROP_UPLOADER_JS.length).toBeGreaterThan(2000);
  });

  it('contains the reception client (drop form + the uploads endpoint)', () => {
    expect(RECEPTION_DROP_UPLOADER_JS).toContain('rcp-form');
    expect(RECEPTION_DROP_UPLOADER_JS).toContain('/uploads');
  });

  it('is WS-FREE — no binary `/ws/upload` framing leaked into the HTTP bundle', () => {
    // The seam's purpose: reception (HTTP) never drags in the WS data plane.
    expect(RECEPTION_DROP_UPLOADER_JS).not.toContain('encodeUploadChunkFrame');
    expect(RECEPTION_DROP_UPLOADER_JS).not.toContain('/ws/upload');
    expect(RECEPTION_DROP_UPLOADER_JS).not.toContain('UPLOAD_FRAME_VERSION');
  });
});
