export interface LoadAttestedWebclientBundleArgs {
  buildDir: string;
  expectedSourceRevision: string;
  expectedCloudApex?: string;
}

export interface AttestedWebclientArchiveFile {
  path: string;
  bytes: Buffer;
}

export interface AttestedWebclientBundle {
  manifestPath: string;
  archiveFiles: AttestedWebclientArchiveFile[];
}

export function loadAttestedWebclientBundle(
  args: LoadAttestedWebclientBundleArgs,
): AttestedWebclientBundle;
