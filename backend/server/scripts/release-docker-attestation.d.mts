export interface DockerAttestationOptions {
  channels: Record<string, unknown>;
  expectedVersion: string;
  run?: (
    command: string,
    args: string[],
    options: { encoding: 'utf8'; windowsHide: true },
  ) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
  log?: (message: string) => void;
}

export declare const assertDockerArtifactsAttested: (
  options: DockerAttestationOptions,
) => number;
