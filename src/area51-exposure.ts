import fs from 'fs';
import path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';

import { scanAgentGate, type AgentGateFinding, type AgentGateReport } from './agent-gate.js';
import {
  selectRuntimePolicy,
  type RuntimeCapability,
  type RuntimeDataSensitivity,
  type RuntimePolicyDecision,
  type RuntimePolicyProfile,
  type RuntimeTrustLevel,
} from './runtime-policy.js';

export type Area51ExposureTarget = 'agent' | 'repo' | 'change';
export type Area51ExposureSeverity = 'info' | 'warning' | 'high';
export type Area51ExposureSurface = 'agent-gate' | 'runtime-policy' | 'verify' | 'repo';

export interface Area51ExposureFinding {
  id: string;
  severity: Area51ExposureSeverity;
  surface: Area51ExposureSurface;
  title: string;
  detail: string;
  evidence: string[];
  recommendation: string;
}

export interface Area51ExposureCheck {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  command?: string[];
  exit_code?: number | null;
  stdout_tail?: string;
  stderr_tail?: string;
  reason?: string;
}

export interface Area51ExposureReport {
  schema: 'area51.exposure.v1';
  generated_at: string;
  target: {
    type: Area51ExposureTarget;
    path: string;
  };
  summary: {
    status: 'pass' | 'warn' | 'fail';
    high_findings: number;
    warning_findings: number;
    checks_failed: number;
    checks_skipped: number;
  };
  agent_gate?: AgentGateReport;
  runtime_policy?: RuntimePolicyDecision;
  checks: Area51ExposureCheck[];
  findings: Area51ExposureFinding[];
  recommendations: string[];
}

export interface Area51ExposureOptions {
  targetPath: string;
  targetType?: Area51ExposureTarget;
  requiredSecrets?: string[];
  quarantine?: boolean;
  failOnWarnings?: boolean;
  runtimeProfile?: RuntimePolicyProfile;
  trustLevel?: RuntimeTrustLevel;
  dataSensitivity?: RuntimeDataSensitivity;
  capabilities?: RuntimeCapability[];
  incusAvailable?: boolean;
  allowDockerFallback?: boolean;
  verify?: boolean;
  packageManager?: 'pnpm' | 'npm' | 'yarn';
  verifyScript?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

const DEFAULT_VERIFY_SCRIPT = 'verify';
const DEFAULT_PACKAGE_MANAGER = 'pnpm';
const TAIL_LIMIT = 3000;

export async function exposeArea51(options: Area51ExposureOptions): Promise<Area51ExposureReport> {
  const now = options.now ?? new Date();
  const targetPath = path.resolve(options.targetPath);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`target path does not exist or is not a directory: ${targetPath}`);
  }

  const targetType = options.targetType ?? inferTargetType(targetPath);
  const findings: Area51ExposureFinding[] = [];
  const checks: Area51ExposureCheck[] = [];

  let agentGate: AgentGateReport | undefined;
  if (targetType === 'agent' || looksLikeAgentTarget(targetPath)) {
    agentGate = await scanAgentGate({
      groupDir: targetPath,
      requiredSecrets: options.requiredSecrets,
      quarantine: options.quarantine ?? true,
      failOnWarnings: options.failOnWarnings ?? false,
      env: options.env ?? process.env,
      now,
    });
    findings.push(...agentGate.findings.map(agentGateFinding));
  } else {
    findings.push({
      id: 'agent-gate-not-applicable',
      severity: 'info',
      surface: 'agent-gate',
      title: 'Agent Gate was not run',
      detail: 'The target does not look like an Area51 agent group, so this exposure focused on repo/change checks.',
      evidence: [targetPath],
      recommendation: 'Pass an agent group folder when you want prompt, skill, MCP, secret, and scenario checks.',
    });
  }

  let runtimePolicy: RuntimePolicyDecision | undefined;
  if (agentGate) {
    runtimePolicy = selectRuntimePolicy(agentGate, {
      profile: options.runtimeProfile ?? (targetType === 'agent' ? 'production' : 'local'),
      trustLevel: options.trustLevel ?? 'approved',
      dataSensitivity: options.dataSensitivity ?? 'business',
      capabilities: options.capabilities ?? inferCapabilities(targetPath),
      incusAvailable: options.incusAvailable ?? false,
      allowDockerFallback: options.allowDockerFallback ?? targetType !== 'agent',
    });
    findings.push(runtimeFinding(runtimePolicy));
  }

  const verifyCheck = runVerifyCheck(targetPath, options);
  if (verifyCheck) {
    checks.push(verifyCheck);
    findings.push(verifyFinding(verifyCheck));
  }

  const gitCheck = inspectGitState(targetPath, targetType, options.runner ?? defaultRunner);
  if (gitCheck) findings.push(gitCheck);

  const recommendations = buildRecommendations(findings, agentGate, runtimePolicy);
  const summary = summarize(findings, checks);

  return {
    schema: 'area51.exposure.v1',
    generated_at: now.toISOString(),
    target: {
      type: targetType,
      path: targetPath,
    },
    summary,
    agent_gate: agentGate,
    runtime_policy: runtimePolicy,
    checks,
    findings,
    recommendations,
  };
}

export function writeArea51ExposureReport(report: Area51ExposureReport, filePath: string): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(report, null, 2) + '\n');
}

export function formatArea51ExposureReport(report: Area51ExposureReport): string {
  const lines: string[] = [];
  lines.push(`Area51 exposure: ${report.summary.status.toUpperCase()}`);
  lines.push(`Target: ${report.target.type} ${report.target.path}`);
  lines.push(
    `Findings: high=${report.summary.high_findings} warning=${report.summary.warning_findings} checks_failed=${report.summary.checks_failed}`,
  );

  if (report.agent_gate) {
    lines.push('');
    lines.push(
      `Agent Gate: ${report.agent_gate.passed ? 'PASS' : 'FAIL'} (${report.agent_gate.overall_fitness_index}/100)`,
    );
  }

  if (report.runtime_policy) {
    lines.push(
      `Runtime Policy: ${report.runtime_policy.action.toUpperCase()}${
        report.runtime_policy.runtime ? ` via ${report.runtime_policy.runtime}` : ''
      } risk=${report.runtime_policy.riskScore}/100`,
    );
  }

  if (report.checks.length > 0) {
    lines.push('');
    lines.push('Checks:');
    for (const check of report.checks) {
      const command = check.command ? ` (${check.command.join(' ')})` : '';
      lines.push(`  [${check.status}] ${check.name}${command}`);
      if (check.reason) lines.push(`    ${check.reason}`);
    }
  }

  lines.push('');
  lines.push('Findings:');
  for (const finding of report.findings) {
    lines.push(`  [${finding.severity}] ${finding.surface}: ${finding.title}`);
    lines.push(`    ${finding.detail}`);
    if (finding.evidence.length > 0) lines.push(`    evidence: ${finding.evidence.slice(0, 3).join(', ')}`);
    lines.push(`    fix: ${finding.recommendation}`);
  }

  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommended next steps:');
    for (const rec of report.recommendations.slice(0, 6)) lines.push(`  - ${rec}`);
  }

  return lines.join('\n');
}

function inferTargetType(targetPath: string): Area51ExposureTarget {
  if (looksLikeAgentTarget(targetPath)) return 'agent';
  return hasGitMetadata(targetPath) ? 'change' : 'repo';
}

function looksLikeAgentTarget(targetPath: string): boolean {
  return [
    'CLAUDE.md',
    'AGENTS.md',
    'container.json',
    path.join('skills'),
    path.join('.agents'),
    path.join('.area51', 'agent-gate'),
  ].some((entry) => fs.existsSync(path.join(targetPath, entry)));
}

function hasGitMetadata(targetPath: string): boolean {
  return fs.existsSync(path.join(targetPath, '.git'));
}

function inferCapabilities(targetPath: string): RuntimeCapability[] {
  const configPath = path.join(targetPath, 'container.json');
  if (!fs.existsSync(configPath)) return ['chat'];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      packages?: { npm?: string[]; apt?: string[] };
      mcpServers?: Record<string, unknown>;
      mcp_servers?: Record<string, unknown>;
    };
    const caps = new Set<RuntimeCapability>(['chat']);
    if ((raw.packages?.npm?.length ?? 0) > 0 || (raw.packages?.apt?.length ?? 0) > 0) caps.add('package-install');
    if (Object.keys(raw.mcpServers ?? raw.mcp_servers ?? {}).length > 0) caps.add('network');
    return [...caps];
  } catch {
    return ['chat'];
  }
}

function agentGateFinding(finding: AgentGateFinding): Area51ExposureFinding {
  return {
    id: finding.id,
    severity: finding.severity,
    surface: 'agent-gate',
    title: finding.title,
    detail: finding.detail,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
  };
}

function runtimeFinding(decision: RuntimePolicyDecision): Area51ExposureFinding {
  const severity: Area51ExposureSeverity =
    decision.action === 'block' || decision.action === 'quarantine'
      ? 'high'
      : decision.requiresIncus
        ? 'warning'
        : 'info';
  return {
    id: `runtime-policy-${decision.action}`,
    severity,
    surface: 'runtime-policy',
    title: `Runtime policy selected ${decision.action}`,
    detail: `Risk ${decision.riskScore}/100. ${decision.reasons.join('; ')}`,
    evidence: decision.controls,
    recommendation:
      decision.action === 'block'
        ? 'Provision Incus or reduce the target risk before running this workload.'
        : decision.action === 'quarantine'
          ? 'Preserve the quarantine artifacts, investigate the evidence, and rebuild from trusted inputs.'
          : 'Run the workload using the selected runtime and keep this decision in the report.',
  };
}

function runVerifyCheck(targetPath: string, options: Area51ExposureOptions): Area51ExposureCheck | null {
  if (options.verify === false) return null;

  const script = options.verifyScript ?? DEFAULT_VERIFY_SCRIPT;
  const packageJsonPath = path.join(targetPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      name: 'package verify',
      status: 'skipped',
      reason: 'No package.json was found at the target path.',
    };
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.[script]) {
    return {
      name: 'package verify',
      status: 'skipped',
      reason: `package.json does not define a "${script}" script.`,
    };
  }

  const packageManager = options.packageManager ?? DEFAULT_PACKAGE_MANAGER;
  const command = packageManager;
  const args = packageManager === 'yarn' ? [script] : ['run', script];
  const result = (options.runner ?? defaultRunner)(command, args, { cwd: targetPath, env: options.env });

  return {
    name: 'package verify',
    status: result.status === 0 ? 'passed' : 'failed',
    command: [command, ...args],
    exit_code: result.status,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr || result.error?.message || ''),
  };
}

function verifyFinding(check: Area51ExposureCheck): Area51ExposureFinding {
  if (check.status === 'passed') {
    return {
      id: 'verify-passed',
      severity: 'info',
      surface: 'verify',
      title: 'Verification passed',
      detail: 'The configured package verification script completed successfully.',
      evidence: check.command ? [check.command.join(' ')] : [],
      recommendation: 'Keep this check in the release evidence.',
    };
  }
  if (check.status === 'skipped') {
    return {
      id: 'verify-skipped',
      severity: 'warning',
      surface: 'verify',
      title: 'Verification was skipped',
      detail: check.reason ?? 'No verification command was available.',
      evidence: [],
      recommendation: 'Add a package verification script so Area51 can prove the target still works.',
    };
  }
  return {
    id: 'verify-failed',
    severity: 'high',
    surface: 'verify',
    title: 'Verification failed',
    detail: `The verification command exited with ${check.exit_code ?? 'no status'}.`,
    evidence: [check.stderr_tail, check.stdout_tail].filter(Boolean) as string[],
    recommendation: 'Fix the failing tests or checks, then rerun Area51 exposure.',
  };
}

function inspectGitState(
  targetPath: string,
  targetType: Area51ExposureTarget,
  runner: CommandRunner,
): Area51ExposureFinding | null {
  if (!hasGitMetadata(targetPath)) return null;
  const status = runner('git', ['status', '--short'], { cwd: targetPath });
  if (status.status !== 0) return null;
  const changes = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (targetType !== 'change' || changes.length === 0) {
    return {
      id: 'git-working-tree-clean',
      severity: 'info',
      surface: 'repo',
      title: 'Git working tree is clean',
      detail: 'No uncommitted changes were found at the target path.',
      evidence: [],
      recommendation: 'Use --target-type change when you want Area51 to explain local modifications before release.',
    };
  }
  return {
    id: 'git-working-tree-has-changes',
    severity: 'warning',
    surface: 'repo',
    title: 'Uncommitted changes are part of the exposure',
    detail: `${changes.length} changed file(s) are present in the working tree.`,
    evidence: changes.slice(0, 20),
    recommendation: 'Review the changed files, run verification, then commit only the intended release delta.',
  };
}

function buildRecommendations(
  findings: Area51ExposureFinding[],
  agentGate: AgentGateReport | undefined,
  runtimePolicy: RuntimePolicyDecision | undefined,
): string[] {
  const recs = new Set<string>();
  for (const finding of findings) {
    if (finding.severity !== 'info') recs.add(finding.recommendation);
  }
  for (const rec of agentGate?.recommendations ?? []) recs.add(rec);
  if (runtimePolicy?.action === 'block')
    recs.add('Do not run this target until the runtime policy blocker is resolved.');
  if (runtimePolicy?.action === 'quarantine')
    recs.add('Treat quarantine evidence as release-blocking until investigated.');
  return [...recs];
}

function summarize(findings: Area51ExposureFinding[], checks: Area51ExposureCheck[]): Area51ExposureReport['summary'] {
  const high = findings.filter((finding) => finding.severity === 'high').length;
  const warning = findings.filter((finding) => finding.severity === 'warning').length;
  const checksFailed = checks.filter((check) => check.status === 'failed').length;
  const checksSkipped = checks.filter((check) => check.status === 'skipped').length;
  return {
    status: high > 0 || checksFailed > 0 ? 'fail' : warning > 0 || checksSkipped > 0 ? 'warn' : 'pass',
    high_findings: high,
    warning_findings: warning,
    checks_failed: checksFailed,
    checks_skipped: checksSkipped,
  };
}

function defaultRunner(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'> {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
  });
}

function tail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= TAIL_LIMIT ? value : value.slice(-TAIL_LIMIT);
}
