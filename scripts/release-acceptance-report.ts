import fs from 'node:fs';
import path from 'node:path';

export type AcceptanceSuite = 'incus-vm-containment' | 'incus-vm-reboot' | 'linux-installer';

type AcceptanceCase = {
  id: string;
  passed: true;
  evidence: string;
};

export type VmRebootMeasurement = {
  schema: 'area51.incus_vm_reboot_measurement.v1';
  instance: string;
  before_boot_id: string;
  after_boot_id: string;
  same_instance: true;
  disk_marker_persisted: true;
  runtime_ready: true;
};

export type ReleaseAcceptanceReport = {
  schema: 'area51.release_acceptance.v1';
  generated_at: string;
  suite: AcceptanceSuite;
  commit_sha: string;
  workflow_run_url: string;
  installer_url: string | null;
  passed: true;
  cases: AcceptanceCase[];
  vm_reboot_measurement: VmRebootMeasurement | null;
  not_covered: string[];
};

const CASES: Record<AcceptanceSuite, Array<Omit<AcceptanceCase, 'passed'>>> = {
  'incus-vm-containment': [
    { id: 'weaker-runtime-fallback-blocked', evidence: 'Risky Docker posture was rejected by Runtime Policy.' },
    { id: 'risky-workload-escalated-to-vm', evidence: 'Production policy selected a real Incus VM.' },
    { id: 'host-control-sockets-hidden', evidence: 'Incus and Docker control sockets were absent in the guest.' },
    { id: 'guest-root-read-only', evidence: 'The non-root agent could not write the VM root filesystem.' },
    { id: 'non-relay-egress-blocked', evidence: 'The relay remained reachable while direct internet egress failed.' },
    { id: 'provider-roundtrip-and-restart', evidence: 'Messaging and provider state survived runtime restart.' },
    { id: 'compromised-runtime-quarantined', evidence: 'The compromised workload was stopped and its NIC removed.' },
    { id: 'quarantine-evidence-retained', evidence: 'Reason, marker, and evidence snapshot were retained.' },
    { id: 'quarantined-execution-rejected', evidence: 'Incus rejected execution after quarantine.' },
  ],
  'incus-vm-reboot': [
    { id: 'same-vm-kernel-rebooted', evidence: 'The same VM reported a different Linux kernel boot ID after restart.' },
    {
      id: 'vm-disk-state-persisted',
      evidence: 'A marker written before restart remained on the same VM disk afterward.',
    },
    {
      id: 'baked-runtime-survived-reboot',
      evidence: 'Bun, agent dependencies, and Area51 source remained usable after restart.',
    },
  ],
  'linux-installer': [
    { id: 'public-commit-pinned-installer', evidence: 'Installer was downloaded from the public raw commit URL.' },
    { id: 'fresh-production-install', evidence: 'The one-command installer completed on a disposable Linux host.' },
    { id: 'container-and-vm-images-ready', evidence: 'Both governed Incus images were present.' },
    { id: 'governance-persisted', evidence: 'Deployment evidence and host-owned runtime settings were verified.' },
    { id: 'egress-service-recovered', evidence: 'Forwarding and NAT rules recovered after service restart.' },
    { id: 'idempotent-reinstall', evidence: 'A second run completed without changing the checkout.' },
  ],
};

export function buildReleaseAcceptanceReport(input: {
  suite: AcceptanceSuite;
  commitSha: string;
  workflowRunUrl: string;
  installerUrl?: string;
  vmRebootMeasurement?: VmRebootMeasurement;
  now?: Date;
}): ReleaseAcceptanceReport {
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) throw new Error('commit SHA must be 40 lowercase hex characters');
  const expectedRunPrefix = 'https://github.com/aviatam/area51/actions/runs/';
  if (!input.workflowRunUrl.startsWith(expectedRunPrefix)) throw new Error('workflow run URL is not an Area51 run');

  let installerUrl: string | null = null;
  if (input.suite === 'linux-installer') {
    installerUrl = input.installerUrl ?? '';
    const expectedInstaller = `https://raw.githubusercontent.com/aviatam/area51/${input.commitSha}/install-linux.sh`;
    if (installerUrl !== expectedInstaller) throw new Error('installer URL is not pinned to the tested commit');
  }
  let vmRebootMeasurement: VmRebootMeasurement | null = null;
  if (input.suite === 'incus-vm-reboot') {
    const measurement = input.vmRebootMeasurement;
    const bootId = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
    if (
      measurement?.schema !== 'area51.incus_vm_reboot_measurement.v1' ||
      typeof measurement.instance !== 'string' ||
      measurement.instance.length === 0 ||
      !bootId.test(measurement.before_boot_id) ||
      !bootId.test(measurement.after_boot_id) ||
      measurement.before_boot_id === measurement.after_boot_id ||
      measurement.same_instance !== true ||
      measurement.disk_marker_persisted !== true ||
      measurement.runtime_ready !== true
    ) {
      throw new Error('valid same-VM reboot measurement is required');
    }
    vmRebootMeasurement = measurement;
  }

  return {
    schema: 'area51.release_acceptance.v1',
    generated_at: (input.now ?? new Date()).toISOString(),
    suite: input.suite,
    commit_sha: input.commitSha,
    workflow_run_url: input.workflowRunUrl,
    installer_url: installerUrl,
    passed: true,
    cases: CASES[input.suite].map((testCase) => ({ ...testCase, passed: true })),
    vm_reboot_measurement: vmRebootMeasurement,
    not_covered: ['live-entra-okta-authorization', 'real-provider-credentials', 'physical-host-reboot'],
  };
}

export function writeReleaseAcceptanceReport(filePath: string, report: ReleaseAcceptanceReport): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function cli(): void {
  const args = process.argv.slice(2);
  const suite = option(args, '--suite') as AcceptanceSuite | undefined;
  const output = option(args, '--output');
  const commitSha = option(args, '--commit');
  const workflowRunUrl = option(args, '--run-url');
  if (!suite || !(suite in CASES)) throw new Error('valid --suite is required');
  if (!output || !commitSha || !workflowRunUrl) throw new Error('--output, --commit, and --run-url are required');

  const measurementPath = option(args, '--measurement');
  const vmRebootMeasurement = measurementPath
    ? (JSON.parse(fs.readFileSync(measurementPath, 'utf8')) as VmRebootMeasurement)
    : undefined;
  const report = buildReleaseAcceptanceReport({
    suite,
    commitSha,
    workflowRunUrl,
    installerUrl: option(args, '--installer-url'),
    vmRebootMeasurement,
  });
  writeReleaseAcceptanceReport(output, report);
  process.stdout.write(`Release acceptance: PASS (${suite}, ${report.cases.length} cases)\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) cli();
