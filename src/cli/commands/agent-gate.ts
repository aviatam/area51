import path from 'path';

import { scanAgentGate, writeAgentGateReport, type AgentGateReport, formatAgentGateReport } from '../../agent-gate.js';
import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { isValidGroupFolder, resolveGroupFolderPath } from '../../group-folder.js';
import { register } from '../registry.js';

interface AgentGateScanArgs {
  group?: string;
  path?: string;
  json_path?: string;
  required_secrets?: string[];
  quarantine: boolean;
  fail_on_warnings: boolean;
  ci: boolean;
}

register<AgentGateScanArgs, AgentGateReport>({
  name: 'agent-gate-scan',
  description: 'Scan an agent group for secrets, packages, integrations, scenarios, and five-pillar readiness.',
  access: 'open',
  hostOnly: true,
  parseArgs: (raw) => {
    const args = normalizeRawArgs(raw);
    const group = optionalString(args.group, 'group');
    const scanPath = optionalString(args.path, 'path');
    if (!group && !scanPath) throw new Error('pass --group <id-or-folder> or --path <agent-folder>');
    if (group && scanPath) throw new Error('pass only one of --group or --path');
    return {
      group,
      path: scanPath,
      json_path: optionalString(args.json_path, 'json-path'),
      required_secrets: parseRequiredSecrets(args.required_secrets),
      quarantine: parseBoolean(args.quarantine, true, 'quarantine'),
      fail_on_warnings: parseBoolean(args.fail_on_warnings, false, 'fail-on-warnings'),
      ci: parseBoolean(args.ci, false, 'ci'),
    };
  },
  handler: async (args) => {
    const groupDir = resolveScanPath(args);
    const report = await scanAgentGate({
      groupDir,
      requiredSecrets: args.required_secrets,
      quarantine: args.quarantine,
      failOnWarnings: args.fail_on_warnings,
    });
    if (args.json_path) writeAgentGateReport(report, args.json_path);
    if (args.ci && !report.passed) {
      const location = args.json_path ? ` Report written to ${path.resolve(args.json_path)}.` : '';
      throw new Error(`Agent gate failed with OFI ${report.overall_fitness_index}/100.${location}`);
    }
    return report;
  },
  formatHuman: formatAgentGateReport,
});

function normalizeRawArgs(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/-/g, '_'), value]));
}

function optionalString(value: unknown, flag: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`--${flag} requires a value`);
  return value;
}

function parseBoolean(value: unknown, fallback: boolean, flag: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`--${flag} must be true or false`);
}

function parseRequiredSecrets(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('--required-secrets requires a comma-separated value');
  return value
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
}

function resolveScanPath(args: AgentGateScanArgs): string {
  if (args.path) return path.resolve(args.path);
  const group = args.group!;
  const byId = getAgentGroup(group);
  if (byId) return resolveGroupFolderPath(byId.folder);
  const byFolder = getAgentGroupByFolder(group);
  if (byFolder) return resolveGroupFolderPath(byFolder.folder);
  if (isValidGroupFolder(group)) return resolveGroupFolderPath(group);
  const absolute = path.resolve(GROUPS_DIR, group);
  throw new Error(`agent group not found or invalid folder: ${group} (${absolute})`);
}
