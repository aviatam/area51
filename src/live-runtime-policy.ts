import fs from 'node:fs';
import path from 'node:path';

import type { AgentGateReport } from './agent-gate.js';
import type { Area51RuntimeBackend } from './config.js';
import type { ContainerConfig } from './container-config.js';
import { listProviderContainerConfigNames } from './providers/provider-container-registry.js';
import {
  selectRuntimePolicy,
  type RuntimeCapability,
  type RuntimePolicyDecision,
  type RuntimePolicyProfile,
  type RuntimeTrustLevel,
} from './runtime-policy.js';

export interface LiveRuntimePolicyInput {
  backend: Area51RuntimeBackend;
  incusInstanceKind: 'container' | 'vm';
  containerConfig: ContainerConfig;
  /** Effective provider after session and group overrides are resolved. */
  provider?: string;
}

/** Select the runtime before any agent-controlled process is created. */
export function selectLiveRuntimePolicy(report: AgentGateReport, input: LiveRuntimePolicyInput): RuntimePolicyDecision {
  const profile: RuntimePolicyProfile =
    input.backend === 'docker' ? 'local' : input.incusInstanceKind === 'vm' ? 'maximum' : 'production';

  return selectRuntimePolicy(report, {
    profile,
    trustLevel: liveTrustLevel(input.containerConfig, input.provider),
    dataSensitivity: 'business',
    capabilities: liveCapabilities(input.containerConfig, input.provider),
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

function liveCapabilities(config: ContainerConfig, effectiveProvider?: string): RuntimeCapability[] {
  const capabilities = new Set<RuntimeCapability>(['chat', 'files', 'network']);
  const extendedPackageSurface = config.packages.apt.length > 0 || config.packages.npm.length > 0;
  const broadMountSurface = config.additionalMounts.length > 0;
  const mcpServers = Object.values(config.mcpServers);
  const nonBuiltInProvider = (effectiveProvider ?? config.provider ?? 'claude').toLowerCase() !== 'claude';
  if (extendedPackageSurface) capabilities.add('package-install');
  if (broadMountSurface) capabilities.add('broad-mount');
  // Package and broad-mount extensions can combine third-party code/data with
  // the normal OneCLI credential route, so score that compound capability.
  if (extendedPackageSurface || broadMountSurface) {
    capabilities.add('shell');
    capabilities.add('secret-access');
  }
  // Stdio MCP servers and provider adapters execute code in the agent runtime.
  // Every MCP server can receive agent data and use the OneCLI credential route.
  if (mcpServers.length > 0) capabilities.add('secret-access');
  if (mcpServers.some((server) => server.type !== 'http') || nonBuiltInProvider) capabilities.add('shell');
  if (nonBuiltInProvider) capabilities.add('secret-access');
  return [...capabilities];
}

function liveTrustLevel(config: ContainerConfig, effectiveProvider?: string): RuntimeTrustLevel {
  let trust: RuntimeTrustLevel = 'built-in';
  const raise = (candidate: RuntimeTrustLevel): void => {
    const rank: Record<RuntimeTrustLevel, number> = { 'built-in': 0, approved: 1, 'third-party': 2, unknown: 3 };
    if (rank[candidate] > rank[trust]) trust = candidate;
  };

  const provider = (effectiveProvider ?? config.provider ?? 'claude').toLowerCase();
  if (provider !== 'claude') {
    raise(listProviderContainerConfigNames().includes(provider) ? 'third-party' : 'unknown');
  }

  for (const name of Object.keys(config.mcpServers)) {
    raise(config.mcpServerProvenance?.[name] ? 'third-party' : 'unknown');
  }
  if (config.packages.apt.length > 0 || config.packages.npm.length > 0) raise('third-party');
  if (config.additionalMounts.length > 0) raise('unknown');

  if (config.skills !== 'all') {
    const builtInSkills = builtInSkillNames();
    if (config.skills.some((skill) => !builtInSkills.has(skill))) raise('unknown');
  }

  return trust;
}

function builtInSkillNames(): Set<string> {
  const root = path.join(process.cwd(), 'container', 'skills');
  try {
    return new Set(fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory()));
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unavailable catalog must fail closed as unknown provenance
  } catch {
    // An explicit skill cannot be treated as built-in when the installed
    // built-in catalog itself is unavailable.
    return new Set();
  }
}
