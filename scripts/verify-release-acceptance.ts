import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_ACCEPTANCE_CASES,
  type AcceptanceSuite,
  type ReleaseAcceptanceReport,
  type VmRebootMeasurement,
} from './release-acceptance-report.js';

type ReleaseAcceptanceSummary = {
  schema: 'area51.release_acceptance.summary.v1';
  generated_at: string;
  commit_sha: string;
  passed: true;
  suites: ReleaseAcceptanceReport[];
};

const REQUIRED_SUITES = Object.keys(RELEASE_ACCEPTANCE_CASES) as AcceptanceSuite[];
const REQUIRED_GAPS = ['live-entra-okta-authorization', 'physical-host-reboot', 'real-provider-credentials'];
const SHA = /^[0-9a-f]{40}$/;
const BOOT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const RUN_URL = /^https:\/\/github\.com\/aviatam\/area51\/actions\/runs\/(\d+)$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactMembers(actual: string[], expected: string[], label: string): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} mismatch: expected ${sortedExpected.join(', ')}, got ${sortedActual.join(', ')}`);
  }
}

function validTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function verifyRebootMeasurement(value: unknown): void {
  const measurement = object(value, 'VM reboot measurement') as Partial<VmRebootMeasurement>;
  if (
    measurement.schema !== 'area51.incus_vm_reboot_measurement.v1' ||
    typeof measurement.instance !== 'string' ||
    measurement.instance.length === 0 ||
    typeof measurement.before_boot_id !== 'string' ||
    typeof measurement.after_boot_id !== 'string' ||
    !BOOT_ID.test(measurement.before_boot_id) ||
    !BOOT_ID.test(measurement.after_boot_id) ||
    measurement.before_boot_id === measurement.after_boot_id ||
    measurement.same_instance !== true ||
    measurement.disk_marker_persisted !== true ||
    measurement.runtime_ready !== true
  ) {
    throw new Error('VM reboot measurement is invalid');
  }
}

export function verifyReleaseAcceptanceSummary(value: unknown, expectedCommit: string): ReleaseAcceptanceSummary {
  if (!SHA.test(expectedCommit)) throw new Error('expected commit must be 40 lowercase hex characters');
  const summary = object(value, 'release acceptance summary');
  if (summary.schema !== 'area51.release_acceptance.summary.v1') throw new Error('summary schema mismatch');
  if (summary.commit_sha !== expectedCommit) throw new Error('summary commit does not match the expected commit');
  if (summary.passed !== true) throw new Error('summary is not marked passed');
  validTimestamp(summary.generated_at, 'summary generated_at');
  if (!Array.isArray(summary.suites)) throw new Error('summary suites must be an array');

  const suites = summary.suites.map((suite, index) => object(suite, `suite ${index}`));
  exactMembers(
    suites.map((suite) => String(suite.suite)),
    REQUIRED_SUITES,
    'acceptance suites',
  );

  let workflowRunId: string | undefined;
  for (const rawSuite of suites) {
    const suite = rawSuite as unknown as ReleaseAcceptanceReport;
    if (suite.schema !== 'area51.release_acceptance.v1') throw new Error(`${suite.suite} schema mismatch`);
    if (suite.commit_sha !== expectedCommit) throw new Error(`${suite.suite} commit mismatch`);
    if (suite.passed !== true) throw new Error(`${suite.suite} is not marked passed`);
    validTimestamp(suite.generated_at, `${suite.suite} generated_at`);

    const runMatch = typeof suite.workflow_run_url === 'string' ? RUN_URL.exec(suite.workflow_run_url) : null;
    if (!runMatch) throw new Error(`${suite.suite} workflow URL is not an Area51 Actions run`);
    workflowRunId ??= runMatch[1];
    if (workflowRunId !== runMatch[1]) throw new Error('acceptance suites reference different workflow runs');

    const expectedCases = RELEASE_ACCEPTANCE_CASES[suite.suite]?.map((testCase) => testCase.id);
    if (!expectedCases || !Array.isArray(suite.cases)) throw new Error(`${suite.suite} cases are invalid`);
    const caseIds = suite.cases.map((testCase) => {
      const candidate = object(testCase, `${suite.suite} case`);
      if (candidate.passed !== true) throw new Error(`${suite.suite} contains a case that did not pass`);
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.evidence !== 'string' ||
        candidate.evidence.length === 0
      ) {
        throw new Error(`${suite.suite} contains malformed case evidence`);
      }
      return candidate.id;
    });
    exactMembers(caseIds, expectedCases, `${suite.suite} cases`);

    if (!Array.isArray(suite.not_covered) || !suite.not_covered.every((gap) => typeof gap === 'string')) {
      throw new Error(`${suite.suite} not_covered must be a string array`);
    }
    for (const gap of REQUIRED_GAPS) {
      if (!suite.not_covered.includes(gap)) throw new Error(`${suite.suite} omits the known gap ${gap}`);
    }

    if (suite.suite === 'linux-installer') {
      const expectedInstaller = `https://raw.githubusercontent.com/aviatam/area51/${expectedCommit}/install-linux.sh`;
      if (suite.installer_url !== expectedInstaller)
        throw new Error('Linux installer URL is not pinned to the tested commit');
      if (suite.vm_reboot_measurement !== null)
        throw new Error('Linux installer suite contains unexpected reboot evidence');
    } else if (suite.suite === 'incus-vm-reboot') {
      if (suite.installer_url !== null) throw new Error('VM reboot suite contains an installer URL');
      verifyRebootMeasurement(suite.vm_reboot_measurement);
    } else {
      if (suite.installer_url !== null || suite.vm_reboot_measurement !== null) {
        throw new Error('VM containment suite contains evidence from another suite');
      }
    }
  }

  return summary as unknown as ReleaseAcceptanceSummary;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function cli(): void {
  const args = process.argv.slice(2);
  const file = option(args, '--file');
  const commit = option(args, '--commit');
  if (!file || !commit) throw new Error('--file and --commit are required');
  const summary = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown;
  const verified = verifyReleaseAcceptanceSummary(summary, commit);
  const caseCount = verified.suites.reduce((total, suite) => total + suite.cases.length, 0);
  process.stdout.write(`Release evidence: VERIFIED (${verified.suites.length} suites, ${caseCount} cases)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`Release evidence: REJECTED (${error instanceof Error ? error.message : String(error)})\n`);
    process.exitCode = 1;
  }
}
