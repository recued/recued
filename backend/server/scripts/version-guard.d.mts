/** Types for the release tooling's shared version guard. The implementation is
 *  plain `.mjs` because the release scripts run without a build step of their
 *  own; this declaration exists so the ratchet test that compares the mirrored
 *  comparator against `packages/release`'s authority can be typechecked. */
export declare const compareVersions: (a: string, b: string) => number;
export declare const FIRST_FOUR_SEGMENT_VERSION: string;
export declare const RELEASE_VERSION_RE: RegExp;
export declare const isValidReleaseVersion: (version: string) => boolean;
export declare const grammarRefusal: (version: string) => string | null;
export declare const isHotfixVersion: (version: string) => boolean;
export declare const hotfixRefusal: (version: string) => string | null;
export declare const assertFleetReadable: (
  version: string,
  where: string,
  exit: (message: string) => void,
) => void;
export declare const configAlignmentRefusal: (
  packageVersion: string,
  channelName: string,
  channelVersion: string | undefined,
) => string | null;
export declare const assertChannelsMatchPackage: (
  packageVersion: string,
  channels: Record<string, { version?: string; min_supported?: string } | undefined> | undefined,
  exit: (message: string) => void,
) => void;
export declare const versionNeedle: (version: string) => Buffer;
export declare const assertBinaryCarriesVersion: (
  bytes: Buffer,
  version: string,
  fileName: string,
  exit: (message: string) => void,
) => void;
export declare const assertExecutableFormat: (
  bytes: Buffer,
  triple: string,
  fileName: string,
  kind: string,
  exit: (message: string) => void,
) => void;
