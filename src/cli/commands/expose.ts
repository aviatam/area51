import {
  exposeArea51,
  formatArea51ExposureReport,
  writeArea51ExposureReport,
  type Area51ExposureReport,
  type Area51ExposureTarget,
} from '../../area51-exposure.js';
import type {
  RuntimeCapability,
  RuntimeDataSensitivity,
  RuntimePolicyProfile,
  RuntimeTrustLevel,
} from '../../runtime-policy.js';
import { register } from '../registry.js';

interface ExposeArgs {
  path: string;
  target_type?: Area51ExposureTarget;
  json_path?: string;
  verify: boolean;
  verify_script?: string;
  package_manager?: 'pnpm' | 'npm' | 'yarn';
  required_secrets?: string[];
  quarantine: boolean;
  fail_on_warnings: boolean;
  runtime_profile?: RuntimePolicyProfile;
  trust_level?: RuntimeTrustLevel;
  data_sensitivity?: RuntimeDataSensitivity;
  capabilities?: RuntimeCapability[];
  incus_available?: boolean;
  allow_docker_fallback?: boolean;
}

register<ExposeArgs, Area51ExposureReport>({
  name: 'expose',
  description:
    'Expose Area51 as one assessment surface for an agent, repo, or code change: scan, verify, decide runtime, and explain findings.',
  access: 'open',
  hostOnly: true,
  parseArgs: (raw) => {
    const args = normalizeRawArgs(raw);
    return {
      path: requiredString(args.path, 'path'),
      target_type: optionalEnum(args.target_type, 'target-type', ['agent', 'repo', 'change']),
      json_path: optionalString(args.json_path, 'json-path'),
      verify: parseBoolean(args.verify, true, 'verify'),
      verify_script: optionalString(args.verify_script, 'verify-script'),
      package_manager: optionalEnum(args.package_manager, 'package-manager', ['pnpm', 'npm', 'yarn']),
      required_secrets: parseCsv(args.required_secrets, 'required-secrets'),
      quarantine: parseBoolean(args.quarantine, true, 'quarantine'),
      fail_on_warnings: parseBoolean(args.fail_on_warnings, false, 'fail-on-warnings'),
      runtime_profile: optionalEnum(args.runtime_profile, 'runtime-profile', ['local', 'production', 'maximum']),
      trust_level: optionalEnum(args.trust_level, 'trust-level', ['built-in', 'approved', 'third-party', 'unknown']),
      data_sensitivity: optionalEnum(args.data_sensitivity, 'data-sensitivity', [
        'low',
        'business',
        'customer',
        'secret',
      ]),
      capabilities: parseCsvEnum(args.capabilities, 'capabilities', [
        'chat',
        'files',
        'network',
        'browser',
        'shell',
        'package-install',
        'broad-mount',
        'secret-access',
      ]),
      incus_available: optionalBoolean(args.incus_available, 'incus-available'),
      allow_docker_fallback: optionalBoolean(args.allow_docker_fallback, 'allow-docker-fallback'),
    };
  },
  handler: async (args) => {
    const report = await exposeArea51({
      targetPath: args.path,
      targetType: args.target_type,
      requiredSecrets: args.required_secrets,
      quarantine: args.quarantine,
      failOnWarnings: args.fail_on_warnings,
      runtimeProfile: args.runtime_profile,
      trustLevel: args.trust_level,
      dataSensitivity: args.data_sensitivity,
      capabilities: args.capabilities,
      incusAvailable: args.incus_available,
      allowDockerFallback: args.allow_docker_fallback,
      verify: args.verify,
      verifyScript: args.verify_script,
      packageManager: args.package_manager,
    });
    if (args.json_path) writeArea51ExposureReport(report, args.json_path);
    return report;
  },
  formatHuman: formatArea51ExposureReport,
});

function normalizeRawArgs(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/-/g, '_'), value]));
}

function requiredString(value: unknown, flag: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`--${flag} requires a value`);
  return value;
}

function optionalString(value: unknown, flag: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`--${flag} requires a value`);
  return value;
}

function parseBoolean(value: unknown, fallback: boolean, flag: string): boolean {
  const parsed = optionalBoolean(value, flag);
  return parsed ?? fallback;
}

function optionalBoolean(value: unknown, flag: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`--${flag} must be true or false`);
}

function optionalEnum<const T extends string>(value: unknown, flag: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`--${flag} requires a value`);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseCsv(value: unknown, flag: string): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`--${flag} requires a comma-separated value`);
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCsvEnum<const T extends string>(value: unknown, flag: string, allowed: readonly T[]): T[] | undefined {
  const values = parseCsv(value, flag);
  if (!values) return undefined;
  for (const entry of values) {
    if (!(allowed as readonly string[]).includes(entry)) {
      throw new Error(`--${flag} must contain only: ${allowed.join(', ')}`);
    }
  }
  return values as T[];
}
