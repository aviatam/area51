import fs from 'node:fs';
import path from 'node:path';

import type { AgentGateReport } from './agent-gate.js';
import type { Area51RuntimeBackend } from './config.js';
import type { ContainerConfig } from './container-config.js';
import {
  selectRuntimePolicy,
  type RuntimeCapability,
  type RuntimePolicyDecision,
  type RuntimePolicyProfile,
} from './runtime-policy.js';

export interface LiveRuntimePolicyInput {
  backend: Area51RuntimeBackend;
  incusInstanceKind: 'container' | 'vm';
  containerConfig: ContainerConfig;
}

/** Select the runtime before any agent-controlled process is created. */
export function selectLiveRuntimePolicy(report: AgentGateReport, input: LiveRuntimePolicyInput): RuntimePolicyDecision {
  const profile: RuntimePolicyProfile =
    input.backend === 'docker' ? 'local' : input.incusInstanceKind === 'vm' ? 'maximum' : 'production';

  return selectRuntimePolicy(report, {
    profile,
    trustLevel: 'approved',
    dataSensitivity: 'business',
    capabilities: liveCapabilities(input.containerConfig),
    incusAvailable: input.backend === 'incus',
    // A risky local workload must block when Incus is unavailable instead of
    // silently inheriting the weaker Docker runtime.
    allowDockerFallback: false,
  });
}

/** Persist a host-owned audit record outside every session mount. */
export function writeLiveRuntimePolicyDecision(
  dataDir: string,
  sessionId: string,
  decision: RuntimePolicyDecision,
): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) throw new Error(`Invalid runtime-policy session id: ${sessionId}`);
  const directory = path.join(dataDir, 'runtime-policy');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${sessionId}.json`);
  const temporary = path.join(directory, `.${sessionId}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function liveCapabilities(config: ContainerConfig): RuntimeCapability[] {
  const capabilities = new Set<RuntimeCapability>(['chat', 'files', 'network']);
  const extendedPackageSurface = config.packages.apt.length > 0 || config.packages.npm.length > 0;
  const broadMountSurface = config.additionalMounts.length > 0;
  if (extendedPackageSurface) capabilities.add('package-install');
  if (broadMountSurface) capabilities.add('broad-mount');
  // Package and broad-mount extensions can combine third-party code/data with
  // the normal OneCLI credential route, so score that compound capability.
  if (extendedPackageSurface || broadMountSurface) {
    capabilities.add('shell');
    capabilities.add('secret-access');
  }
  return [...capabilities];
}
