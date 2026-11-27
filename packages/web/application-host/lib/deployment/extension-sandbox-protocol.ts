export const extensionNodeBase = '/api/harness/managed-execution/v1';
export const extensionBrokerPath = extensionNodeBase + '/extension-brokers/';
export const extensionIntegrity = /^sha256-[a-f0-9]{64}$/u;
export const extensionNodeCredential = '/run/secrets/varin-extension-node.json';
export const extensionSandboxProtocolVersion = 1;

export const brokerFrame = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
