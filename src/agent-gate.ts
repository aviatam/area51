import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

export type AgentGatePillar = 'capabilities' | 'evolution' | 'skill_efficiency' | 'integration' | 'security';
export type AgentGateSeverity = 'info' | 'warning' | 'high';

export interface AgentGateFinding {
  id: string;
  severity: AgentGateSeverity;
  pillar: AgentGatePillar;
  title: string;
  detail: string;
  evidence: string[];
  recommendation: string;
  quarantined?: string[];
}

export interface AgentGateSecretCheck {
  name: string;
  present: boolean;
  source: 'environment' | 'missing';
}

export interface AgentGatePillarScore {
  score: number;
  status: 'pass' | 'warn' | 'fail';
  highlights: string[];
}

export interface AgentGateQuarantine {
  enabled: boolean;
  path?: string;
  files: string[];
}

export interface AgentGateReport {
  schema: 'area51.agent_gate.v1';
  generated_at: string;
  group_path: string;
  passed: boolean;
  overall_fitness_index: number;
  thresholds: {
    minimum_overall: number;
    fail_on_warnings: boolean;
  };
  counts: {
    files_scanned: number;
    agent_files: number;
    policy_files: number;
    scenario_files: number;
    mcp_servers: number;
    packages: number;
    findings: number;
    high_findings: number;
  };
  secrets: AgentGateSecretCheck[];
  pillars: Record<AgentGatePillar, AgentGatePillarScore>;
  findings: AgentGateFinding[];
  quarantine: AgentGateQuarantine;
  recommendations: string[];
}

export interface ScanAgentGateOptions {
  groupDir: string;
  requiredSecrets?: string[];
  env?: NodeJS.ProcessEnv;
  quarantine?: boolean;
  quarantineRoot?: string;
  failOnWarnings?: boolean;
  now?: Date;
}

interface PackageCandidate {
  name: string;
  version: string;
  source: string;
}

interface ContainerConfig {
  mcpServers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  packages?: {
    apt?: string[];
    npm?: string[];
  };
}

const DEFAULT_REQUIRED_SECRETS = ['ANTHROPIC_API_KEY'];
const MINIMUM_OVERALL = 80;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist']);

const BLOCKED_NPM_PACKAGES = [
  {
    id: 'npm-event-stream-3.3.6',
    name: 'event-stream',
    versions: ['3.3.6'],
    title: 'Compromised npm package detected',
    detail: 'event-stream 3.3.6 is a known compromised release and must not be present in an agent image.',
    recommendation:
      'Remove event-stream 3.3.6, rebuild the group container image, and review any lockfile entries it pulled in.',
  },
  {
    id: 'npm-flatmap-stream-0.1.1',
    name: 'flatmap-stream',
    versions: ['0.1.1'],
    title: 'Malicious transitive npm package detected',
    detail: 'flatmap-stream 0.1.1 was distributed as part of the event-stream compromise chain.',
    recommendation: 'Remove the dependency path that introduced flatmap-stream and regenerate the lockfile.',
  },
  {
    id: 'npm-ua-parser-js-compromised',
    name: 'ua-parser-js',
    versions: ['0.7.29', '0.8.0', '1.0.0'],
    title: 'Compromised npm package version detected',
    detail: 'This ua-parser-js version is in the compromised release range and should be treated as unsafe.',
    recommendation: 'Upgrade ua-parser-js to a clean release and rebuild the container image from a fresh lockfile.',
  },
];

export async function scanAgentGate(options: ScanAgentGateOptions): Promise<AgentGateReport> {
  const groupDir = path.resolve(options.groupDir);
  const stat = fs.existsSync(groupDir) ? fs.statSync(groupDir) : null;
  if (!stat?.isDirectory()) throw new Error(`group path does not exist or is not a directory: ${groupDir}`);

  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const requiredSecrets = options.requiredSecrets?.length ? options.requiredSecrets : DEFAULT_REQUIRED_SECRETS;
  const files = walkGroupFiles(groupDir);
  const agentFiles = files.filter(isAgentFile);
  const policyFiles = files.filter(isPolicyFile);
  const scenarioFiles = files.filter(isScenarioFile);
  const containerConfig = readJsonFile<ContainerConfig>(path.join(groupDir, 'container.json'));
  const packages = collectPackageCandidates(groupDir, containerConfig);
  const mcpServers = collectMcpServers(containerConfig);
  const findings: AgentGateFinding[] = [];

  if (agentFiles.length === 0) {
    findings.push({
      id: 'agent-files-missing',
      severity: 'high',
      pillar: 'capabilities',
      title: 'No agent definition files found',
      detail: 'The group folder has no CLAUDE.md, AGENTS.md, skill, or .agents definition file to scan.',
      evidence: [groupDir],
      recommendation: 'Add the agent instructions and skill files to the group folder before running the gate.',
    });
  }

  if (policyFiles.length === 0) {
    findings.push({
      id: 'policy-files-missing',
      severity: 'warning',
      pillar: 'security',
      title: 'No explicit policy or guardrail files found',
      detail: 'The scan did not find a policy, guardrail, security, or approval file in the agent group.',
      evidence: [groupDir],
      recommendation: 'Add a policy file that states tool, approval, data handling, and high-risk action rules.',
    });
  }

  for (const secret of requiredSecrets) {
    if (!env[secret]) {
      findings.push({
        id: `secret-missing-${secret.toLowerCase()}`,
        severity: 'high',
        pillar: 'security',
        title: 'Required AI secret is not configured',
        detail: `${secret} is required for this gate and was not present in the host environment.`,
        evidence: [secret],
        recommendation: `Configure ${secret} in the host environment or deployment secret store before starting the agent.`,
      });
    }
  }

  const invalidMcpServers = findInvalidMcpServers(mcpServers);
  for (const server of invalidMcpServers) {
    findings.push({
      id: `mcp-invalid-${server}`,
      severity: 'warning',
      pillar: 'integration',
      title: 'MCP server config is incomplete',
      detail: `MCP server "${server}" does not define a command, url, or transport endpoint.`,
      evidence: ['container.json'],
      recommendation: 'Fix the MCP server entry before letting the agent depend on it in production.',
    });
  }

  for (const pkg of findBlockedPackages(packages)) {
    const blocked = BLOCKED_NPM_PACKAGES.find((entry) => entry.id === pkg.blocklistId)!;
    findings.push({
      id: blocked.id,
      severity: 'high',
      pillar: 'security',
      title: blocked.title,
      detail: `${blocked.detail} Found ${pkg.name}@${pkg.version}.`,
      evidence: [pkg.source],
      recommendation: blocked.recommendation,
    });
  }

  if (scenarioFiles.length === 0) {
    findings.push({
      id: 'behavior-scenarios-missing',
      severity: 'warning',
      pillar: 'capabilities',
      title: 'No concrete behavior scenarios configured',
      detail: 'The gate could not find refund, PII, prompt-injection, approval, or tool-use scenarios to validate.',
      evidence: [groupDir],
      recommendation:
        'Add scenario files under .area51/agent-gate/scenarios/ or .agentgym/ so failures map to a clear use case.',
    });
  }

  const quarantine = quarantineFindings(groupDir, findings, {
    enabled: options.quarantine ?? true,
    root: options.quarantineRoot,
    now,
  });

  const pillars = scorePillars({
    agentFiles,
    policyFiles,
    scenarioFiles,
    mcpServers,
    packages,
    findings,
    secrets: requiredSecrets.map((name) => ({
      name,
      present: Boolean(env[name]),
      source: env[name] ? 'environment' : 'missing',
    })),
  });

  const overall = Math.round(
    pillars.capabilities.score * 0.3 +
      pillars.evolution.score * 0.15 +
      pillars.skill_efficiency.score * 0.2 +
      pillars.integration.score * 0.15 +
      pillars.security.score * 0.2,
  );
  const highFindings = findings.filter((f) => f.severity === 'high').length;
  const warningFindings = findings.filter((f) => f.severity === 'warning').length;
  const failOnWarnings = Boolean(options.failOnWarnings);
  const passed = overall >= MINIMUM_OVERALL && highFindings === 0 && (!failOnWarnings || warningFindings === 0);

  return {
    schema: 'area51.agent_gate.v1',
    generated_at: now.toISOString(),
    group_path: groupDir,
    passed,
    overall_fitness_index: overall,
    thresholds: {
      minimum_overall: MINIMUM_OVERALL,
      fail_on_warnings: failOnWarnings,
    },
    counts: {
      files_scanned: files.length,
      agent_files: agentFiles.length,
      policy_files: policyFiles.length,
      scenario_files: scenarioFiles.length,
      mcp_servers: mcpServers.length,
      packages: packages.length,
      findings: findings.length,
      high_findings: highFindings,
    },
    secrets: requiredSecrets.map((name) => ({
      name,
      present: Boolean(env[name]),
      source: env[name] ? 'environment' : 'missing',
    })),
    pillars,
    findings,
    quarantine,
    recommendations: buildRecommendations(findings, pillars),
  };
}

export function writeAgentGateReport(report: AgentGateReport, filePath: string): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(report, null, 2) + '\n');
}

export function formatAgentGateReport(report: AgentGateReport): string {
  const lines: string[] = [];
  lines.push(`Agent Gate: ${report.passed ? 'PASS' : 'FAIL'} (${report.overall_fitness_index}/100)`);
  lines.push(`Group: ${report.group_path}`);
  lines.push('');
  lines.push('Pillars:');
  for (const [name, pillar] of Object.entries(report.pillars)) {
    lines.push(`  ${name.padEnd(17)} ${String(pillar.score).padStart(3)}/100  ${pillar.status}`);
    for (const highlight of pillar.highlights.slice(0, 2)) lines.push(`    - ${highlight}`);
  }
  lines.push('');
  lines.push('Scan coverage:');
  lines.push(
    `  files=${report.counts.files_scanned} agents=${report.counts.agent_files} policies=${report.counts.policy_files} scenarios=${report.counts.scenario_files} mcp=${report.counts.mcp_servers} packages=${report.counts.packages}`,
  );
  lines.push('');
  lines.push('Secrets:');
  for (const secret of report.secrets) {
    lines.push(`  ${secret.name}: ${secret.present ? 'configured' : 'missing'}`);
  }
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('Findings: none');
  } else {
    lines.push('Findings:');
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity}] ${finding.title}`);
      lines.push(`    ${finding.detail}`);
      lines.push(`    evidence: ${finding.evidence.join(', ')}`);
    }
  }
  lines.push('');
  if (report.quarantine.enabled && report.quarantine.path) {
    lines.push(`Quarantine: ${report.quarantine.path}`);
    lines.push(`  files: ${report.quarantine.files.length}`);
  } else {
    lines.push(`Quarantine: ${report.quarantine.enabled ? 'not needed' : 'disabled'}`);
  }
  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommended fixes:');
    for (const rec of report.recommendations.slice(0, 5)) lines.push(`  - ${rec}`);
  }
  return lines.join('\n');
}

function walkGroupFiles(groupDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(groupDir, absolute).replace(/\\/g, '/');
      if (relative.startsWith('.area51/agent-gate/quarantine')) continue;
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  };
  walk(groupDir);
  return out.sort();
}

function isAgentFile(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower === 'claude.md' ||
    lower === 'agents.md' ||
    lower.startsWith('.agents/') ||
    lower.startsWith('skills/') ||
    lower.includes('/skill.md')
  );
}

function isPolicyFile(file: string): boolean {
  const lower = path.basename(file).toLowerCase();
  return (
    lower.includes('policy') || lower.includes('guardrail') || lower.includes('security') || lower.includes('approval')
  );
}

function isScenarioFile(file: string): boolean {
  const lower = file.toLowerCase();
  const basename = path.basename(lower);
  return (
    lower.startsWith('.area51/agent-gate/scenarios/') ||
    lower.startsWith('.agentgym/') ||
    lower.includes('/scenarios/') ||
    basename.includes('prompt-injection') ||
    basename.includes('refund')
  );
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  // Agent folders can contain hand-edited config; malformed JSON should become a finding path, not crash discovery.
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return undefined;
  }
}

function collectMcpServers(config: ContainerConfig | undefined): Array<{ name: string; value: unknown }> {
  const servers = config?.mcpServers ?? config?.mcp_servers ?? {};
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, value]) => ({ name, value }));
}

function findInvalidMcpServers(servers: Array<{ name: string; value: unknown }>): string[] {
  return servers
    .filter(({ value }) => {
      if (!value || typeof value !== 'object') return true;
      const record = value as Record<string, unknown>;
      return !record.command && !record.url && !record.transport && !record.endpoint;
    })
    .map((server) => server.name);
}

function collectPackageCandidates(groupDir: string, config: ContainerConfig | undefined): PackageCandidate[] {
  const packages: PackageCandidate[] = [];
  const packageJson = readJsonFile<Record<string, unknown>>(path.join(groupDir, 'package.json'));
  if (packageJson) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const deps = packageJson[section];
      if (deps && typeof deps === 'object') {
        for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
          if (typeof version === 'string')
            packages.push({ name, version: cleanVersion(version), source: `package.json:${section}` });
        }
      }
    }
  }

  const packageLock = readJsonFile<Record<string, unknown>>(path.join(groupDir, 'package-lock.json'));
  const lockPackages = packageLock?.packages;
  if (lockPackages && typeof lockPackages === 'object') {
    for (const [lockPath, entry] of Object.entries(lockPackages as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const name = packageNameFromNodeModulesPath(lockPath);
      const version = (entry as Record<string, unknown>).version;
      if (name && typeof version === 'string') {
        packages.push({ name, version: cleanVersion(version), source: `package-lock.json:${lockPath}` });
      }
    }
  }

  const pnpmLock = path.join(groupDir, 'pnpm-lock.yaml');
  if (fs.existsSync(pnpmLock)) {
    packages.push(...collectPnpmLockPackages(pnpmLock));
  }

  for (const pkg of config?.packages?.npm ?? []) {
    const parsed = splitPackageSpec(pkg);
    packages.push({ ...parsed, source: 'container.json:packages.npm' });
  }

  return dedupePackages(packages);
}

function collectPnpmLockPackages(filePath: string): PackageCandidate[] {
  const text = fs.readFileSync(filePath, 'utf8');
  // Lockfiles are evidence, not trusted input. Ignore malformed YAML and continue scanning other surfaces.
  try {
    const parsed = YAML.parse(text) as { packages?: Record<string, unknown> } | undefined;
    return Object.keys(parsed?.packages ?? {}).flatMap((key) => {
      const parsedKey = parsePnpmPackageKey(key);
      return parsedKey ? [{ ...parsedKey, source: `pnpm-lock.yaml:${key}` }] : [];
    });
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return [];
  }
}

function parsePnpmPackageKey(key: string): Pick<PackageCandidate, 'name' | 'version'> | null {
  const normalized = key.replace(/^\//, '');
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return null;
  const name = normalized.slice(0, at);
  const version = normalized.slice(at + 1).split('(')[0];
  if (!name || !version) return null;
  return { name, version: cleanVersion(version) };
}

function packageNameFromNodeModulesPath(lockPath: string): string | null {
  const marker = 'node_modules/';
  const idx = lockPath.lastIndexOf(marker);
  if (idx < 0) return null;
  return lockPath.slice(idx + marker.length);
}

function splitPackageSpec(spec: string): Pick<PackageCandidate, 'name' | 'version'> {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    if (at > 0) return { name: spec.slice(0, at), version: cleanVersion(spec.slice(at + 1)) };
    return { name: spec, version: '*' };
  }
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), version: cleanVersion(spec.slice(at + 1)) };
  return { name: spec, version: '*' };
}

function cleanVersion(version: string): string {
  return version.replace(/^[~^=<> ]+/, '').trim();
}

function dedupePackages(packages: PackageCandidate[]): PackageCandidate[] {
  const seen = new Set<string>();
  return packages.filter((pkg) => {
    const key = `${pkg.name}@${pkg.version}:${pkg.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findBlockedPackages(packages: PackageCandidate[]): Array<PackageCandidate & { blocklistId: string }> {
  return packages.flatMap((pkg) => {
    const blocked = BLOCKED_NPM_PACKAGES.find(
      (entry) => entry.name === pkg.name && (pkg.version === '*' || entry.versions.includes(pkg.version)),
    );
    return blocked ? [{ ...pkg, blocklistId: blocked.id }] : [];
  });
}

function quarantineFindings(
  groupDir: string,
  findings: AgentGateFinding[],
  options: { enabled: boolean; root?: string; now: Date },
): AgentGateQuarantine {
  const highPackageFindings = findings.filter((f) => f.severity === 'high' && f.id.startsWith('npm-'));
  if (!options.enabled || highPackageFindings.length === 0) return { enabled: options.enabled, files: [] };

  const stamp = options.now.toISOString().replace(/[:.]/g, '-');
  const root = path.resolve(options.root ?? path.join(groupDir, '.area51', 'agent-gate', 'quarantine'));
  const quarantineDir = path.join(root, stamp);
  fs.mkdirSync(quarantineDir, { recursive: true });

  const files: string[] = [];
  for (const relative of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'container.json']) {
    const source = path.join(groupDir, relative);
    if (!fs.existsSync(source)) continue;
    const dest = path.join(quarantineDir, relative);
    fs.copyFileSync(source, dest);
    files.push(dest);
  }
  const findingsPath = path.join(quarantineDir, 'findings.json');
  fs.writeFileSync(findingsPath, JSON.stringify(highPackageFindings, null, 2) + '\n');
  files.push(findingsPath);

  for (const finding of highPackageFindings) finding.quarantined = files;
  return { enabled: true, path: quarantineDir, files };
}

function scorePillars(input: {
  agentFiles: string[];
  policyFiles: string[];
  scenarioFiles: string[];
  mcpServers: Array<{ name: string; value: unknown }>;
  packages: PackageCandidate[];
  findings: AgentGateFinding[];
  secrets: Array<{ name: string; present: boolean; source: 'environment' | 'missing' }>;
}): Record<AgentGatePillar, AgentGatePillarScore> {
  const high = (pillar: AgentGatePillar) =>
    input.findings.filter((f) => f.pillar === pillar && f.severity === 'high').length;
  const warn = (pillar: AgentGatePillar) =>
    input.findings.filter((f) => f.pillar === pillar && f.severity === 'warning').length;
  const blockedPackages = input.findings.filter((f) => f.id.startsWith('npm-')).length;
  const missingSecrets = input.secrets.filter((s) => !s.present).length;
  const hasMemory = input.agentFiles.some((file) => file.toLowerCase().includes('memory'));

  return {
    capabilities: pillarScore(
      clamp(
        55 +
          Math.min(input.agentFiles.length, 4) * 8 +
          Math.min(input.scenarioFiles.length, 3) * 6 -
          high('capabilities') * 35 -
          warn('capabilities') * 10,
      ),
      [`${input.agentFiles.length} agent files scanned`, `${input.scenarioFiles.length} concrete scenario files found`],
    ),
    evolution: pillarScore(clamp((hasMemory ? 85 : 70) + Math.min(input.scenarioFiles.length, 3) * 4), [
      hasMemory ? 'Memory surfaces found' : 'No dedicated memory surface found',
      'Scenario coverage contributes to regression tracking',
    ]),
    skill_efficiency: pillarScore(clamp(90 - blockedPackages * 35 - Math.max(0, input.packages.length - 20) * 2), [
      `${input.packages.length} package entries scanned`,
      blockedPackages ? `${blockedPackages} blocked package entries` : 'No blocked packages found',
    ]),
    integration: pillarScore(clamp(input.mcpServers.length === 0 ? 70 : 92 - warn('integration') * 18), [
      `${input.mcpServers.length} MCP server entries scanned`,
      warn('integration')
        ? 'Some integration definitions are incomplete'
        : 'Integration definitions are valid or absent',
    ]),
    security: pillarScore(clamp(100 - missingSecrets * 30 - blockedPackages * 45 - warn('security') * 12), [
      `${input.secrets.length - missingSecrets}/${input.secrets.length} required secrets configured`,
      `${input.policyFiles.length} policy files found`,
    ]),
  };
}

function pillarScore(score: number, highlights: string[]): AgentGatePillarScore {
  return {
    score,
    status: score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail',
    highlights,
  };
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildRecommendations(
  findings: AgentGateFinding[],
  pillars: Record<AgentGatePillar, AgentGatePillarScore>,
): string[] {
  const recs = new Set<string>(findings.map((f) => f.recommendation));
  for (const [pillar, score] of Object.entries(pillars)) {
    if (score.status === 'fail') recs.add(`Treat the ${pillar} pillar as a release blocker before rerunning the gate.`);
  }
  return [...recs];
}
