/** Contract namespace keys escape literal dots and percent signs so segment
 * boundaries remain exact for point reads and prefix scans. */
const escapeSegment = (value: string): string => value.replace(/%/g, '%25').replace(/\./g, '%2E');
const unescapeSegment = (value: string): string => value.replace(/%2E/g, '.').replace(/%25/g, '%');
export const encodeContractSegmentKey = (segments: readonly string[]): string => segments.map(escapeSegment).join('.');
export const decodeContractSegmentKey = (key: string): string[] => key.split('.').map(unescapeSegment);
