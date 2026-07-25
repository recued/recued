/** D-152 P0 - hostname registry adapter for listener SNI dispatch. */

import { canBindHostname } from '@recued/contracts';
import type { HostnameSniBindingLookup } from '@recued/server-tls';
import {
  HostnameRegistryError,
  type HostnameRegistryStore,
} from '../storage/hostname-registry.js';

export const createHostnameSniBindingLookup = (
  store: Pick<HostnameRegistryStore, 'get'>,
): HostnameSniBindingLookup =>
  (servername) => {
    try {
      const row = store.get(servername);
      if (!row || !canBindHostname(row)) return null;
      return {
        hostname: row.hostname_normalized,
        cert_source: row.cert_source,
        tls_topology: row.tls_topology,
      };
    } catch (err) {
      if (err instanceof HostnameRegistryError && err.code === 'invalid_hostname') {
        return null;
      }
      throw err;
    }
  };
