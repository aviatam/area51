import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'area51.linux_reboot_acceptance.v1' as const;

export interface Baseline {
  schema: 'area51.linux_reboot_baseline.v1';
  recorded_at: string;
  boot_id: string;
  commit_sha: string;
}

export interface HostState {
  baselineBootId: string;
  currentBootId: string;
  incusActive: boolean;
  egressActive: boolean;
  area51Active: boolean;
  containerImageReady: boolean;
  vmImageReady: boolean;
  governanceEvidenceValid: boolean;
  checkoutClean: boolean;
  commitUnchanged: boolean;
}

export interface RebootReport {
  schema: typeof SCHEMA;
  generated_at: string;
  passed: boolean;
  kernel_boot_changed: boolean;
  cases: Array<{ id: string; passed: boolean }>;
}

function evidenceDir(root: string): string {
  return path.join(root, '.area51', 'reboot-verification');
}

export function writeBaseline(root: string, baseline: Baseline, replace = false): string {
  const directory = evidenceDir(root);
  const target = path.join(directory, 'baseline.json');
  if (fs.existsSync(target) && !replace) throw new Error('reboot baseline already exists; use --replace to start over');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

export function readBaseline(root: string): Baseline {
  const target = path.join(evidenceDir(root), 'baseline.json');
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<Baseline>;
  if (
    parsed.schema !== 'area51.linux_reboot_baseline.v1' ||
    typeof parsed.boot_id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(parsed.boot_id) ||
    typeof parsed.commit_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(parsed.commit_sha)
  ) {
    throw new Error('invalid reboot baseline');
  }
  return parsed as Baseline;
}

export function buildReport(state: HostState, now = new Date()): RebootReport {
  const cases = [
    { id: 'boot-id-changed', passed: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.currentBootId) && state.currentBootId !== state.baselineBootId },
    { id: 'incus-service-active', passed: state.incusActive },
    { id: 'egress-service-active', passed: state.egressActive },
    { id: 'area51-service-active', passed: state.area51Active },
    { id: 'incus-container-image-ready', passed: state.containerImageReady },
    { id: 'incus-vm-image-ready', passed: state.vmImageReady },
    { id: 'governance-evidence-valid', passed: state.governanceEvidenceValid },
    { id: 'checkout-clean', passed: state.checkoutClean },
    { id: 'commit-unchanged', passed: state.commitUnchanged },
  ];
  return {
    schema: SCHEMA,
    generated_at: now.toISOString(),
    passed: cases.every((testCase) => testCase.passed),
    kernel_boot_changed: cases[0]!.passed,
    cases,
  };
}

export function writeReport(root: string, report: RebootReport, output?: string): string {
  const target = path.resolve(root, output ?? path.join(evidenceDir(root), 'report.json'));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

function succeeds(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout: 30_000 }).status === 0;
}

function governanceValid(root: string): boolean {
  try {
    const report = JSON.parse(
      fs.readFileSync(path.join(root, '.area51', 'governed-demo', 'reports', 'deployment.json'), 'utf8'),
    ) as Record<string, unknown>;
    return report.mode === 'production' && report.deployment_passed === true && report.governance_applied === true;
  } catch {
    return false;
  }
}

function area51ServiceActive(root: string): boolean {
  const command = [
    'export PROJECT_ROOT="$1" AREA51_PROJECT_ROOT="$1"',
    'source "$1/setup/lib/install-slug.sh"',
    'unit="$(systemd_unit)"',
    'systemctl --user is-active --quiet "${unit}.service" || systemctl --user is-active --quiet "$unit"',
  ].join('; ');
  return succeeds('bash', ['-c', command, '_', root]);
}

export function collectHostState(root: string, baseline: Baseline): HostState {
  if (process.platform !== 'linux') throw new Error('Linux is required for physical reboot verification');
  const currentBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return {
    commitUnchanged: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim() === baseline.commit_sha,
    baselineBootId: baseline.boot_id,
    currentBootId,
    incusActive: succeeds('systemctl', ['is-active', '--quiet', 'incus.service']),
    egressActive: succeeds('systemctl', ['is-active', '--quiet', 'area51-incus-egress.service']),
    area51Active: area51ServiceActive(root),
    containerImageReady: succeeds('incus', ['image', 'info', 'area51-agent-v2']),
    vmImageReady: succeeds('incus', ['image', 'info', 'area51-agent-v2-vm']),
    governanceEvidenceValid: governanceValid(root),
    checkoutClean: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '',
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(args = process.argv.slice(2), root = process.cwd()): void {
  const action = args[0];
  if (action === 'record') {
    if (process.platform !== 'linux') throw new Error('Linux is required for physical reboot verification');
    const baseline: Baseline = {
      schema: 'area51.linux_reboot_baseline.v1',
      recorded_at: new Date().toISOString(),
      boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      commit_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    };
    const target = writeBaseline(root, baseline, args.includes('--replace'));
    process.stdout.write(`Linux reboot baseline recorded: ${target}\n`);
    return;
  }
  if (action === 'verify') {
    const report = buildReport(collectHostState(root, readBaseline(root)));
    const target = writeReport(root, report, option(args, '--output'));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\nEvidence: ${target}\n`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  throw new Error('usage: verify.ts <record|verify> [--replace] [--output path]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
