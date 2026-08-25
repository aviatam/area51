import type { AgentGateReport } from './agent-gate.js';

export type RuntimePolicyProfile = 'local' | 'production' | 'maximum';
export type RuntimeTrustLevel = 'built-in' | 'approved' | 'third-party' | 'unknown';
export type RuntimeDataSensitivity = 'low' | 'business' | 'customer' | 'secret';
export type RuntimeCapability =
  'chat' | 'files' | 'network' | 'browser' | 'shell' | 'package-install' | 'broad-mount' | 'secret-access';

export type RuntimeKind = 'docker' | 'incus-container' | 'incus-vm';
export type RuntimeDecisionAction = 'allow' | 'quarantine' | 'block';

export interface RuntimePolicyOptions {
  profile?: RuntimePolicyProfile;
  trustLevel?: RuntimeTrustLevel;
  dataSensitivity?: RuntimeDataSensitivity;
  capabilities?: RuntimeCapability[];
  incusAvailable?: boolean;
  allowDockerFallback?: boolean;
}

export interface RuntimePolicyDecision {
  schema: 'area51.runtime_policy.v1';
  action: RuntimeDecisionAction;
  runtime?: RuntimeKind;
  riskScore: number;
  requiresIncus: boolean;
  quarantineRequired: boolean;
  reasons: string[];
  controls: string[];
}

const HIGH_RISK_CAPABILITIES = new Set<RuntimeCapability>([
  'browser',
  'shell',
  'package-install',
  'broad-mount',
  'secret-access',
]);

export function selectRuntimePolicy(
  report: AgentGateReport,
  options: RuntimePolicyOptions = {},
): RuntimePolicyDecision {
  const profile = options.profile ?? 'local';
  const trustLevel = options.trustLevel ?? 'approved';
  const dataSensitivity = options.dataSensitivity ?? 'business';
  const capabilities = options.capabilities ?? ['chat'];
  const incusAvailable = options.incusAvailable ?? false;
  const allowDockerFallback = options.allowDockerFallback ?? profile === 'local';

  const reasons: string[] = [];
  const controls: string[] = ['host-owned runtime decision', 'agent cannot request or mount the Incus socket'];
  let riskScore = 0;

  if (!report.passed) {
    riskScore += 25;
    reasons.push('Agent Gate did not pass');
  }

  if (report.counts.high_findings > 0) {
    riskScore += report.counts.high_findings * 35;
    reasons.push(`${report.counts.high_findings} high-severity Agent Gate finding(s)`);
  }

  const warningCount = report.findings.filter((finding) => finding.severity === 'warning').length;
  if (warningCount > 0) {
    riskScore += Math.min(30, warningCount * 8);
    reasons.push(`${warningCount} warning Agent Gate finding(s)`);
  }

  const missingSecrets = report.secrets.filter((secret) => !secret.present).length;
  if (missingSecrets > 0) {
    riskScore += missingSecrets * 25;
    reasons.push(`${missingSecrets} required secret(s) missing`);
  }

  if (trustLevel === 'third-party') {
    riskScore += 18;
    reasons.push('third-party agent or skill source');
  } else if (trustLevel === 'unknown') {
    riskScore += 30;
    reasons.push('unknown agent or skill source');
  }

  for (const capability of capabilities) {
    if (HIGH_RISK_CAPABILITIES.has(capability)) {
      riskScore += capabilityRisk(capability);
      reasons.push(`high-risk capability requested: ${capability}`);
    }
  }

  if (dataSensitivity === 'customer') {
    riskScore += 15;
    reasons.push('customer data sensitivity');
  } else if (dataSensitivity === 'secret') {
    riskScore += 30;
    reasons.push('secret-bearing data sensitivity');
  }

  if (profile === 'production') {
    riskScore += 10;
    controls.push('production profile prefers Incus for medium/high-risk work');
  } else if (profile === 'maximum') {
    riskScore += 20;
    controls.push('maximum profile requires Incus VM isolation');
  }

  riskScore = clampRisk(riskScore);

  const compromisedPackage = report.findings.some(
    (finding) => finding.severity === 'high' && finding.id.startsWith('npm-'),
  );
  const quarantineRequired = compromisedPackage || report.quarantine.files.length > 0;

  if (quarantineRequired) {
    controls.push(
      'freeze or stop instance',
      'snapshot evidence',
      'remove normal network profile',
      'apply quarantine profile',
    );
    return {
      schema: 'area51.runtime_policy.v1',
      action: incusAvailable ? 'quarantine' : 'block',
      runtime: incusAvailable ? (profile === 'maximum' ? 'incus-vm' : 'incus-container') : undefined,
      riskScore: 100,
      requiresIncus: true,
      quarantineRequired: true,
      reasons: [...reasons, 'quarantine evidence was produced by Agent Gate'],
      controls,
    };
  }

  const needsIncus = profile === 'maximum' || profile === 'production' || riskScore >= 50;
  if (needsIncus && !incusAvailable && !allowDockerFallback) {
    return {
      schema: 'area51.runtime_policy.v1',
      action: 'block',
      riskScore,
      requiresIncus: true,
      quarantineRequired: false,
      reasons: [...reasons, 'Incus is required by policy but is not available'],
      controls,
    };
  }

  const runtime = chooseRuntime({ profile, riskScore, needsIncus, incusAvailable, allowDockerFallback });
  if (runtime === 'docker') controls.push('local compatibility runtime');
  if (runtime === 'incus-container') controls.push('isolated Incus project', 'resource-limited Incus container');
  if (runtime === 'incus-vm') controls.push('isolated Incus project', 'VM boundary for maximum-risk work');

  return {
    schema: 'area51.runtime_policy.v1',
    action: 'allow',
    runtime,
    riskScore,
    requiresIncus: runtime !== 'docker' || (needsIncus && !allowDockerFallback),
    quarantineRequired: false,
    reasons: reasons.length > 0 ? reasons : ['low-risk trusted workload'],
    controls,
  };
}

function chooseRuntime(input: {
  profile: RuntimePolicyProfile;
  riskScore: number;
  needsIncus: boolean;
  incusAvailable: boolean;
  allowDockerFallback: boolean;
}): RuntimeKind {
  if (input.profile === 'maximum' && input.incusAvailable) return 'incus-vm';
  if (input.incusAvailable && (input.needsIncus || input.riskScore >= 50)) {
    return input.riskScore >= 80 ? 'incus-vm' : 'incus-container';
  }
  if (input.profile === 'production' && input.incusAvailable) return 'incus-container';
  return 'docker';
}

function capabilityRisk(capability: RuntimeCapability): number {
  switch (capability) {
    case 'package-install':
    case 'broad-mount':
      return 25;
    case 'shell':
    case 'secret-access':
      return 20;
    case 'browser':
      return 15;
    default:
      return 0;
  }
}

function clampRisk(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
