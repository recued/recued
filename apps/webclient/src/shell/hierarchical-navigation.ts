/**
 * Shared hierarchical address + History contract for route-owned workspaces.
 *
 * A shell hash is only a flat array of positional segments. Product surfaces
 * are not flat: Seller has directory -> collection -> page/detail, while an
 * installed workflow pack contributes pack -> generated view -> result. This
 * module keeps those semantic levels alongside the serialized hash and owns
 * the one safe History write protocol used by every in-page navigator.
 *
 * Places may be authored statically or projected at runtime. Commands are not
 * places: callers navigate only after choosing a collection/view/detail/result
 * address, never merely because a write was dispatched. That boundary prevents
 * Back/Forward or route hydration from replaying a mutation.
 */

import {
  parseShellRoute,
  serializeShellRoute,
  type WebclientRouteId,
} from './route.js';

/** One semantic level in a route hierarchy. A level may emit more than one
 * positional shell segment (`page/3`, `detail/<id>`), while `key` remains the
 * stable identity used to compare ancestry. */
export interface HierarchicalAddressLevel {
  readonly key: string;
  readonly segments: readonly string[];
}

export interface HierarchicalAddress {
  readonly surface: WebclientRouteId;
  readonly levels: readonly HierarchicalAddressLevel[];
  /** Canonical hash produced by the central shell serializer. */
  readonly hash: string;
}

/** Convenience constructor that also makes malformed dynamic descriptors fail
 * at their producer instead of silently collapsing into a shallower address. */
export const hierarchicalLevel = (
  key: string,
  ...segments: readonly string[]
): HierarchicalAddressLevel => {
  if (key.trim().length === 0) {
    throw new Error('hierarchicalLevel: key must not be empty');
  }
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error('hierarchicalLevel: segments must not be empty');
  }
  return { key, segments: [...segments] };
};

/** Build one canonical address from fixed or runtime-projected levels. */
export const hierarchicalAddress = (
  surface: WebclientRouteId,
  ...levels: readonly HierarchicalAddressLevel[]
): HierarchicalAddress => ({
  surface,
  levels: levels.map((level) => ({
    key: level.key,
    segments: [...level.segments],
  })),
  hash: serializeShellRoute(
    surface,
    ...levels.flatMap((level) => level.segments),
  ),
});

/** Attach semantic levels to an address produced by a richer route serializer
 * (for example Data's source-record return path). The hash is parsed and
 * reserialized so the shared controller still compares a canonical address. */
export const hierarchicalAddressFromHash = (
  surface: WebclientRouteId,
  hash: string,
  ...levels: readonly HierarchicalAddressLevel[]
): HierarchicalAddress => {
  const parsed = parseShellRoute(hash);
  if (parsed.surface !== surface) {
    throw new Error(
      `hierarchicalAddressFromHash: expected ${surface}, received ${parsed.surface}`,
    );
  }
  return {
    surface,
    levels: levels.map((level) => ({
      key: level.key,
      segments: [...level.segments],
    })),
    hash: serializeShellRoute(surface, ...parsed.segments),
  };
};

/** A strict ancestor shares the same surface and complete semantic prefix. */
export const isHierarchicalAncestor = (
  candidate: HierarchicalAddress,
  address: HierarchicalAddress,
): boolean => {
  if (
    candidate.surface !== address.surface
    || candidate.levels.length >= address.levels.length
  ) return false;
  return candidate.levels.every(
    (level, index) => level.key === address.levels[index]?.key,
  );
};

export type HierarchicalHistoryMode = 'push' | 'replace';
export type HierarchicalHistoryIntent = 'auto' | HierarchicalHistoryMode;

/** Entering a deeper place gets a native Back target. Moving sideways, closing
 * a detail, or canonicalizing an address replaces the current entry. Callers
 * can override this when the semantic parent is intentionally absent from the
 * serialized hierarchy (for example, detail opened from a paged collection). */
export const hierarchicalHistoryMode = (
  previous: HierarchicalAddress,
  next: HierarchicalAddress,
): HierarchicalHistoryMode =>
  isHierarchicalAncestor(previous, next) ? 'push' : 'replace';

export interface HierarchicalHistoryLike {
  readonly state?: unknown;
  pushState?: (data: unknown, unused: string, url?: string | URL | null) => void;
  replaceState?: (data: unknown, unused: string, url?: string | URL | null) => void;
}

export interface HierarchicalHistoryCommit {
  readonly committed: boolean;
  readonly mode: HierarchicalHistoryMode | 'none';
  readonly address: HierarchicalAddress;
}

export interface CreateHierarchicalHistoryOptions {
  readonly initial: HierarchicalAddress;
  /** A provider supports hosts that attach a browser/embedding History seam
   * after route construction (and avoids freezing a replaced window object). */
  readonly history?:
    | HierarchicalHistoryLike
    | null
    | (() => HierarchicalHistoryLike | null | undefined);
  /** Called only after a successful URL write. The shell uses this to keep its
   * cached active hash aligned because History writes emit no hashchange. */
  readonly onCommit?: (
    address: HierarchicalAddress,
    mode: HierarchicalHistoryMode,
  ) => void;
}

export interface HierarchicalHistoryController {
  current(): HierarchicalAddress;
  /** Record an address the browser/shell already owns without writing a second
   * history entry. Useful when hydrating a deep link or handling PopState. */
  adopt(address: HierarchicalAddress): void;
  navigate(
    address: HierarchicalAddress,
    options?: {
      readonly intent?: HierarchicalHistoryIntent;
      readonly state?: unknown;
    },
  ): HierarchicalHistoryCommit;
}

/** Stateful, exception-safe History writer shared by mounted route surfaces. */
export const createHierarchicalHistory = (
  options: CreateHierarchicalHistoryOptions,
): HierarchicalHistoryController => {
  let currentAddress = options.initial;

  return {
    current: () => currentAddress,
    adopt: (address) => {
      currentAddress = address;
    },
    navigate: (address, navigation = {}) => {
      if (address.hash === currentAddress.hash) {
        // The semantic descriptor may have become richer while resolving a
        // dynamic surface even though the canonical URL stayed the same.
        currentAddress = address;
        return { committed: true, mode: 'none', address };
      }

      const requested = navigation.intent === undefined
        || navigation.intent === 'auto'
        ? hierarchicalHistoryMode(currentAddress, address)
        : navigation.intent;
      let actualMode: HierarchicalHistoryMode = requested;
      try {
        // Resolve the provider and read the History methods inside the same
        // boundary as the write. Embedded/closing windows can throw from any
        // of those accesses, not only from pushState/replaceState themselves.
        const history = typeof options.history === 'function'
          ? options.history()
          : options.history;
        const canPush = requested === 'push'
          && typeof history?.pushState === 'function';
        actualMode = canPush ? 'push' : 'replace';
        const writer = canPush ? history.pushState : history?.replaceState;
        if (history === null || history === undefined || typeof writer !== 'function') {
          return { committed: false, mode: actualMode, address };
        }
        writer.call(history, navigation.state ?? null, '', address.hash);
      } catch {
        // In-memory navigation still succeeds in the owning surface. Keep the
        // last committed address as the comparison baseline and do not desync
        // the shell cache from the unchanged URL.
        return { committed: false, mode: actualMode, address };
      }

      currentAddress = address;
      try {
        // The URL is already committed. A cache/observer failure must not make
        // the owning surface abort its corresponding in-memory transition.
        options.onCommit?.(address, actualMode);
      } catch {
        // Observer isolation is deliberate; there is no rollback for a
        // successful History write and reporting failure would be dishonest.
      }
      return { committed: true, mode: actualMode, address };
    },
  };
};
