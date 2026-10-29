import type { AIOutput, ChatMessageAttachment } from '@recued/contracts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : null;
export interface OutputFile { file_ref: string; filename: string; sha256: string; size_bytes: number; mime_type: string }

/** Only explicit file artifacts from completed recipe results are candidates.
 * Nested document contents, held/failed runs and model URLs cannot mint one. */
export const outputFilesFromResults = (calls: readonly { result?: unknown }[] = []): OutputFile[] => {
  const files = new Map<string, OutputFile>();
  for (const call of calls) {
    const dispatch = object(call.result);
    if (dispatch?.ok !== true || dispatch.run_failed || dispatch.run_held || dispatch.pending) continue;
    const result = object(dispatch.result), output = object(result?.output);
    if (result?.success !== true || !Array.isArray(output?.render)) continue;
    for (const section of output.render) {
      const part = object(section);
      if (part?.type !== 'file_artifact') continue;
      for (const raw of Array.isArray(part.data) ? part.data : [part.data]) {
        const file = object(raw);
        if (typeof file?.record_id !== 'string' || !/^file:[a-f0-9]{32}$/.test(file.record_id)
          || typeof file.filename !== 'string' || !file.filename.length || file.filename.length > 512
          || typeof file.mime_type !== 'string' || !file.mime_type.length
          || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
          || !Number.isSafeInteger(file.size_bytes) || Number(file.size_bytes) < 0) continue;
        files.set(file.record_id, { file_ref: file.record_id, filename: file.filename,
          sha256: file.sha256, size_bytes: Number(file.size_bytes), mime_type: file.mime_type });
      }
    }
  }
  return [...files.values()].slice(-20);
};

export const OUTPUT_FILE_GUIDANCE = 'When a recipe returns file_artifact output, select the finished deliverables in the optional AIOutput field "output_files": an array of complete file_ref strings copied from those artifacts. The server attaches those exact files to your answer with download controls. Select only the requested final outputs, not intermediate files. Do not invent download URLs or use file: Markdown links. Use output_files: [] only when no generated file should be delivered, and explain any unfinished work.';

export const outputFileSelectionValid = (output: AIOutput, files: readonly OutputFile[]): boolean =>
  Array.isArray(output.output_files) && output.output_files.length <= 20
  && new Set(output.output_files).size === output.output_files.length
  && output.output_files.every(ref => typeof ref === 'string' && files.some(file => file.file_ref === ref));

/** Invalid selections are never partially delivered. Storage revalidates the
 * hash and retains immutable versions before committing the assistant row. */
export const answerOutputAttachments = (
  target: string, output: AIOutput | undefined, calls: readonly { result?: unknown }[] | undefined,
): ChatMessageAttachment[] => {
  const files = outputFilesFromResults(calls);
  if (target !== 'self' || !output || output.tool_calls.length || !outputFileSelectionValid(output, files)) return [];
  return output.output_files!.map(ref => {
    const file = files.find(candidate => candidate.file_ref === ref)!;
    return { file_id: ref, media_class: 'document', content_hash: file.sha256 };
  });
};
