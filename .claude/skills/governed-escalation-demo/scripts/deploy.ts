import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { upsertEnvVar } from '../../../../setup/set-env.js';
import { runGovernedDemo } from './run.js';

type Mode = 'contract' | 'production' | 'live';
type Check = { id: string; passed: boolean; required: boolean; detail: string };

export function inspectDeployment(mode: Mode): Check[] {
  const linux = process.platform === 'linux';
  const checks: Check[] = [
    check('node-20-plus', Number(process.versions.node.split('.')[0]) >= 20, true, `node ${process.version}`),
    check('pnpm-available', commandWorks('pnpm', ['--version']), true, 'pnpm on PATH'),
    check('supported-platform', linux || process.platform === 'darwin', true, process.platform),
  ];
  if (mode !== 'contract') {
    checks.push(
      check('linux-host', linux, true, process.platform),
      check('incus-daemon', commandWorks('incus', ['version']), true, 'incus version'),
      check('kvm-device', fs.existsSync('/dev/kvm'), true, '/dev/kvm'),
      check('kvm-readable', canAccess('/dev/kvm', fs.constants.R_OK), true, '/dev/kvm readable'),
      check('kvm-writable', canAccess('/dev/kvm', fs.constants.W_OK), true, '/dev/kvm writable'),
    );
  }
  return checks;
}

export async function deploy(args: string[]): Promise<number> {
  const mode = value(args, '--mode', 'contract') as Mode;
  if (!['contract', 'production', 'live'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const outputDir = path.resolve(value(args, '--output-dir', '.area51/governed-demo'));
  const planOnly = args.includes('--plan');
  const checks = inspectDeployment(mode);
  const preflightPassed = checks.filter((c) => c.required).every((c) => c.passed);
  writeReport(outputDir, { mode, phase: 'preflight', plan_only: planOnly, preflight_passed: preflightPassed, checks });
  printChecks(checks);
  if (planOnly) return preflightPassed ? 0 : 2;
  if (!preflightPassed) return 2;

  if (mode === 'contract') {
    const result = await runGovernedDemo(outputDir);
    const passed = result.assertions.every((a) => a.passed);
    writeReport(outputDir, { mode, phase: 'complete', preflight_passed: true, deployment_passed: passed, checks });
    return passed ? 0 : 1;
  }

  if (mode === 'live') {
    const result = run(process.execPath, ['--import', 'tsx', 'scripts/incus-vm-containment-e2e.ts']);
    writeReport(outputDir, {
      mode,
      phase: 'complete',
      preflight_passed: true,
      deployment_passed: result === 0,
      checks,
    });
    return result;
  }

  if (process.getuid?.() === 0) throw new Error('Production deployment must run as a regular user, not root.');
  let status = run('bash', ['container/incus/build.sh']);
  if (status !== 0) return status;
  status = run('bash', ['container/incus/build-vm.sh']);
  if (status !== 0) return status;
  const envPath = path.resolve('.env');
  const previousEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath) : null;
  upsertEnvVar('AREA51_RUNTIME_BACKEND', 'incus');
  upsertEnvVar('AREA51_INCUS_INSTANCE_KIND', 'container');
  upsertEnvVar('AREA51_INCUS_IMAGE', 'local:area51-agent-v2');
  status = run('bash', ['area51.sh']);
  if (status !== 0) {
    if (previousEnv === null) fs.rmSync(envPath, { force: true });
    else fs.writeFileSync(envPath, previousEnv);
    return status;
  }
  const result = await runGovernedDemo(outputDir);
  const passed = result.assertions.every((a) => a.passed);
  writeReport(outputDir, {
    mode,
    phase: 'complete',
    preflight_passed: true,
    deployment_passed: passed,
    governance_applied: true,
    checks,
  });
  return passed ? 0 : 1;
}

function run(command: string, args: string[]): number {
  return spawnSync(command, args, { stdio: 'inherit', env: process.env }).status ?? 1;
}
function commandWorks(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}
function canAccess(file: string, mode: number): boolean {
  try {
    fs.accessSync(file, mode);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'ENOENT') return false;
    throw error;
  }
}
function check(id: string, passed: boolean, required: boolean, detail: string): Check {
  return { id, passed, required, detail };
}
function value(args: string[], flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function writeReport(outputDir: string, value: unknown): void {
  fs.mkdirSync(path.join(outputDir, 'reports'), { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'reports', 'deployment.json'),
    `${JSON.stringify({ schema: 'area51.bundle_deployment.v1', generated_at: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, hostname: os.hostname() }, ...value }, null, 2)}\n`,
  );
}
function printChecks(checks: Check[]): void {
  for (const c of checks) process.stdout.write(`${c.passed ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  deploy(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(
        `Area51 bundle deployment failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
