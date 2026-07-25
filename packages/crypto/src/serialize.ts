/** Bundle serialization — JSON is the canonical on-wire form.
 *
 *  Fields are already base64 where relevant, so JSON is compact and
 *  QR-safe. We export helpers for:
 *    - JSON string ↔ Bundle: for PRO cloud rows, WS rpc payloads
 *    - File format (`.recued-bundle`): versioned header + JSON body
 *    - QR payload: same as JSON but with a 1-char scheme prefix so
 *      scanners can route it
 *
 *  Version field lives inside the bundle itself; this module validates
 *  structure but delegates version policy to bundle.ts (which is the
 *  only place that decides what to do with an unknown version).
 */

import type { Bundle } from './bundle.js';

const REQUIRED_FIELDS: (keyof Bundle)[] = [
  'version', 'argon2', 'salt_pw', 'salt_rec', 'wrapped_pw', 'wrapped_rec', 'updated_at',
];

const isBundleShape = (v: unknown): v is Bundle => {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in obj)) return false;
  }
  if (typeof obj.version !== 'number') return false;
  if (typeof obj.salt_pw !== 'string') return false;
  if (typeof obj.salt_rec !== 'string') return false;
  if (typeof obj.wrapped_pw !== 'string') return false;
  if (typeof obj.wrapped_rec !== 'string') return false;
  if (typeof obj.updated_at !== 'number') return false;
  if (!obj.argon2 || typeof obj.argon2 !== 'object') return false;
  const a = obj.argon2 as Record<string, unknown>;
  if (typeof a.t !== 'number' || typeof a.m !== 'number' || typeof a.p !== 'number') return false;
  return true;
};

/** Serialize a bundle to JSON text. Stable key order for reproducibility. */
export const bundleToJSON = (bundle: Bundle): string => JSON.stringify({
  version: bundle.version,
  argon2: { t: bundle.argon2.t, m: bundle.argon2.m, p: bundle.argon2.p },
  salt_pw: bundle.salt_pw,
  salt_rec: bundle.salt_rec,
  wrapped_pw: bundle.wrapped_pw,
  wrapped_rec: bundle.wrapped_rec,
  updated_at: bundle.updated_at,
});

export const bundleFromJSON = (json: string): Bundle => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('serialize: bundle JSON is malformed');
  }
  if (!isBundleShape(parsed)) {
    throw new Error('serialize: bundle JSON is missing required fields');
  }
  return parsed;
};

/** QR scheme prefix. Scanners seeing this can route to Recued's import flow. */
export const QR_SCHEME = 'recued:bundle/v1/';

export const bundleToQR = (bundle: Bundle): string =>
  QR_SCHEME + bundleToJSON(bundle);

export const bundleFromQR = (qr: string): Bundle => {
  if (!qr.startsWith(QR_SCHEME)) {
    throw new Error(`serialize: QR payload must start with "${QR_SCHEME}"`);
  }
  return bundleFromJSON(qr.slice(QR_SCHEME.length));
};

/** File format — JSON body with a magic header line.
 *  ex: `# recued-bundle v1\n{"version":1,...}` */
export const FILE_HEADER = '# recued-bundle v1';

export const bundleToFile = (bundle: Bundle): string =>
  FILE_HEADER + '\n' + bundleToJSON(bundle);

export const bundleFromFile = (contents: string): Bundle => {
  const lines = contents.split('\n');
  if (!lines[0].startsWith('# recued-bundle')) {
    throw new Error('serialize: not a recued-bundle file (missing header)');
  }
  return bundleFromJSON(lines.slice(1).join('\n'));
};
