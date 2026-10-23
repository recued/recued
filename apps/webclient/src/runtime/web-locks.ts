/** A restricted browser can throw while exposing an optional Web Locks API.
 * Only capability discovery falls back; callers still own acquisition failures. */
export const readWebLockProvider = <T extends { request: unknown }>(
  read: () => T | null | undefined,
): T | null => {
  try {
    const provider = read();
    return provider != null && typeof provider.request === 'function' ? provider : null;
  } catch {
    return null;
  }
};
