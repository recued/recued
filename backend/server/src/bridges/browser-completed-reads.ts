import { BROWSER_COMPLETED_READS_CHARS, BROWSER_COMPLETED_DATA_CHARS, isBrowserFieldEvidence,
  type BrowserCompletedData, type BrowserCompletedRead, type BrowserFailureDetails, type BrowserPageObservation } from '@recued/contracts';
import { limitPageObservation } from './browser-page-observation.js';

export interface CompletedBrowserRead {
  step: number; page: string; url?: string; title?: string; data: Record<string, unknown>;
}

/** Keep the most recent completed reads, with their original document identity.
 * This projects only ordinary sanitized read output, never action inputs or
 * arbitrary error details. A failure does not make an old observation current. */
export const completedBrowserReads = (reads: readonly CompletedBrowserRead[], failedStep: number, data: readonly BrowserCompletedData[] = []):
  Pick<BrowserFailureDetails, 'completed_reads' | 'completed_reads_truncated' | 'completed_data' | 'completed_data_truncated'> => {
  const keptData: BrowserCompletedData[] = [];
  let dataTruncated = false;
  for (const capture of [...data].reverse()) {
    if (capture.step >= failedStep) continue;
    const { value: _value, ...metadata } = capture;
    const reference = { ...metadata, value_omitted: true };
    if (keptData.length === 8 || JSON.stringify([...keptData, reference]).length > BROWSER_COMPLETED_DATA_CHARS) { dataTruncated = true; continue; }
    keptData.push(reference);
  }
  // Keep references first. Inline whole small results only from confirmed
  // earlier steps and only when the existing aggregate budget still permits.
  for (const [index, reference] of keptData.entries()) {
    const capture = data.find(item => item.step === reference.step && item.data_ref === reference.data_ref);
    if (!capture || capture.value_omitted) continue;
    const candidate = keptData.map((item, n) => n === index ? capture : item);
    if (JSON.stringify(candidate).length <= BROWSER_COMPLETED_DATA_CHARS) keptData[index] = capture;
  }
  const dataAnswer = data.length ? { completed_data: keptData.reverse(), ...(dataTruncated ? { completed_data_truncated: true as const } : {}) } : {};
  const dataChars = data.length ? JSON.stringify(keptData).length : 0;
  const source = reads.filter(read => read.step < failedStep);
  if (!source.length) return dataAnswer;
  const kept: BrowserCompletedRead[] = [];
  let truncated = false;
  for (const read of [...source].reverse()) {
    if (kept.length === 8 || read.page.length > 128) { truncated = true; continue; }
    const form = typeof read.data.outline === 'string' ? 'outline' : typeof read.data.text === 'string' ? 'text'
      : typeof read.data.lines === 'string' ? 'lines' : undefined;
    if (!form) { truncated = true; continue; }
    const content = read.data[form] as string;
    const loading = read.data.loading === true;
    const observation: BrowserPageObservation = { state: 'snapshot', page: read.page,
      ...(read.url && read.url.length <= 2_048 ? { url: read.url } : {}),
      ...(read.title ? { title: read.title.slice(0, 200) } : {}), loading, source_truncated: read.data.truncated === true,
      ...(!loading && isBrowserFieldEvidence(read.data.field_evidence) ? { field_evidence: read.data.field_evidence } : {}) };
    const bounded = limitPageObservation(observation, 1_800);
    if (!bounded?.page) { truncated = true; continue; }
    const entry: BrowserCompletedRead = { step: read.step, observation: bounded, form, content: content.slice(0, 3_000),
      ...(content.length > 3_000 || bounded.truncated || read.url && !observation.url || (read.title?.length ?? 0) > 200
        ? { truncated: true as const } : {}) };
    // JSON escaping also consumes the carrier budget. Preserve metadata and
    // shorten only content; never manufacture a shortened actionable handle.
    while (JSON.stringify([...kept, entry]).length + dataChars > BROWSER_COMPLETED_READS_CHARS && entry.content.length) {
      entry.content = entry.content.slice(0, Math.max(0, entry.content.length - 256)); entry.truncated = true;
    }
    if (JSON.stringify([...kept, entry]).length + dataChars > BROWSER_COMPLETED_READS_CHARS) { truncated = true; continue; }
    if (entry.truncated) truncated = true;
    kept.push(entry);
  }
  return { ...dataAnswer, completed_reads: kept.reverse(), ...(truncated ? { completed_reads_truncated: true as const } : {}) };
};
