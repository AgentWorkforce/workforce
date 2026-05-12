// TODO(human): replace this with the persona-kit SandboxConfig export once the schema diff lands.
export interface SandboxConfig {
  enabled?: boolean;
  timeoutSeconds?: number;
  env?: Record<string, string>;
}
