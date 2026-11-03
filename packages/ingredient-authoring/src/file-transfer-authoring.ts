import { HTTP_UPLOAD_MAX_BYTES_CEILING, type RestResponseCaptureSpec, type HttpOneShotUploadSpec, type HttpUploadSpec } from '@recued/contracts';

export interface FileTransferField {
  key: string; type: 'string' | 'number' | 'object'; required: boolean; description: string;
  choices?: readonly { value: string; description: string }[];
}
type Field = Omit<FileTransferField, 'key'>;
type Filename = RestResponseCaptureSpec['filename_source'];
const choices = <T extends string>(help: Record<T, string>) => Object.entries(help).map(([value, description]) => ({ value, description: description as string }));
const captureKinds: Record<RestResponseCaptureSpec['kind'], string> = {
  file_ref: 'Capture the response body into stored file data and return a file reference with filename, MIME type and status. Requires GET and read risk; pagination, result_path and response_json are incompatible.',
};
const filenameKinds: Record<Filename['kind'], string> = {
  header: 'Use the response Content-Disposition filename, falling back to download when it is unavailable.',
  static: 'Use the authored non-empty display filename. This labels the captured file; it does not select a local path.',
  arg: 'Read a non-empty string from the named operation argument. Otherwise the response header or download fallback supplies the filename.',
};
const enrichment: Record<NonNullable<RestResponseCaptureSpec['ai_enrichment']>, string> = {
  opt_out: 'Skip unattended AI enrichment of the captured file. An explicit owner recipe may still send it to AI. Omit this setting to follow the file origin rule; the editor does not choose that policy.',
};
const uploadKinds: Record<HttpUploadSpec['kind'], string> = {
  binary: 'Send the stored file as the entire raw request body. No multipart field is admitted. Sending a file requires non-read risk and explicit approval policy.',
  multipart: 'Send the stored file as a named multipart form part. The provider field name is authored separately. Sending a file requires non-read risk and explicit approval policy.',
  chunked: 'Use the existing multi-request upload protocol. It needs authored init, append, finalize and bounded protocol settings; this editor batch does not scaffold those phases.',
};
export const restCaptureKindAllowed = (value: unknown): value is RestResponseCaptureSpec['kind'] => typeof value === 'string' && Object.hasOwn(captureKinds, value);
export const restFilenameKindAllowed = (value: unknown): value is Filename['kind'] => typeof value === 'string' && Object.hasOwn(filenameKinds, value);
export const restEnrichmentAllowed = (value: unknown): value is NonNullable<RestResponseCaptureSpec['ai_enrichment']> => typeof value === 'string' && Object.hasOwn(enrichment, value);
export const httpUploadKindAllowed = (value: unknown): value is HttpUploadSpec['kind'] => typeof value === 'string' && Object.hasOwn(uploadKinds, value);
const string = (description: string, required = false, values?: FileTransferField['choices']): Field => ({ type: 'string', required, description, ...(values ? { choices: values } : {}) });
const capture: Record<keyof RestResponseCaptureSpec, Field> = {
  kind: string(captureKinds.file_ref, true, choices(captureKinds)),
  filename_source: { type: 'object', required: true, description: 'Choose a header, static value or operation argument for the captured file display name. This does not select an endpoint or a local path.' },
  mime_type: string('Fallback MIME type used only when the response has no usable Content-Type. The response type wins when present. Provider MIME values remain authored.'),
  ai_enrichment: string(enrichment.opt_out, false, choices(enrichment)),
};
type FilenameFields = { [K in Filename['kind']]: Record<keyof Extract<Filename, { kind: K }>, Field> };
const filenameKind = string('Choose the filename source explicitly; changing kind preserves existing metadata for review.', true, choices(filenameKinds));
const filenames: FilenameFields = {
  header: { kind: filenameKind },
  static: { kind: filenameKind, value: string(filenameKinds.static, true) },
  arg: { kind: filenameKind, arg: string(filenameKinds.arg + ' F12 on a declared argument opens its source.', true) },
};
const upload: Record<keyof HttpOneShotUploadSpec, Field> = {
  kind: string('Choose how the stored file is sent. Changing kind leaves fields, bounds, risk and approval for explicit review.', true, choices(uploadKinds)),
  arg: string('Name one declared operation argument of type file_ref. The runtime resolves stored bytes from that reference; filenames, filesystem paths and file_ref arrays are not upload sources. F12 opens its declaration.', true),
  field: string('Provider multipart form-field name. Required for multipart; forbidden for binary. The editor does not infer this wire name.', true),
  max_bytes: { type: 'number', required: false, description: 'Optional positive byte ceiling for a one-shot upload. It may only lower the shared handler limit of ' + HTTP_UPLOAD_MAX_BYTES_CEILING + ' bytes. Omission uses that limit; the editor chooses no value.' },
};
/** Only declaration-owned metadata; provider bodies and chunked phase programs remain opaque. */
export const restFileTransferFields = (section: 'binding' | 'capture' | 'filename' | 'upload', mode?: unknown): FileTransferField[] => {
  let fields: Record<string, Field>;
  if (section === 'binding') fields = {
    response_capture: { type: 'object', required: false, description: captureKinds.file_ref },
    upload: { type: 'object', required: false, description: 'Explicitly declare stored-file byte egress. Choose a mode and a file_ref argument; risk, approval, provider fields and limits remain authored.' },
  };
  else if (section === 'capture') fields = mode === undefined || restCaptureKindAllowed(mode) ? capture : { kind: capture.kind };
  else if (section === 'filename') fields = restFilenameKindAllowed(mode) ? filenames[mode] : { kind: filenameKind };
  else fields = mode === 'multipart' ? upload : mode === 'binary' ? { kind: upload.kind, arg: upload.arg, max_bytes: upload.max_bytes } : { kind: upload.kind };
  return Object.entries(fields).map(([key, value]) => ({ key, ...value }));
};
