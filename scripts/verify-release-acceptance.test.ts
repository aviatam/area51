import { describe, expect, it } from 'vitest';

import { buildReleaseAcceptanceReport } from './release-acceptance-report.js';
import { verifyReleaseAcceptanceSummary } from './verify-release-acceptance.js';

const commit = 'a'.repeat(40);
const runUrl = 'https://github.com/aviatam/area51/actions/runs/123456789';
const now = new Date('2026-09-26T12:00:00.000Z');
const installerUrl = `https://raw.githubusercontent.com/aviatam/area51/${commit}/install-linux.sh`;

function validSummary(): Record<string, unknown> {
  return {
    schema: 'area51.release_acceptance.summary.v1',
    generated_at: now.toISOString(),
    commit_sha: commit,
    passed: true,
    suites: [
      buildReleaseAcceptanceReport({ suite: 'incus-vm-containment', commitSha: commit, workflowRunUrl: runUrl, now }),
      buildReleaseAcceptanceReport({
        suite: 'incus-vm-reboot',
        commitSha: commit,
        workflowRunUrl: runUrl,
        now,
        vmRebootMeasurement: {
          schema: 'area51.incus_vm_reboot_measurement.v1',
          instance: 'area51-vm-image-smoke-123',
          before_boot_id: '11111111-1111-1111-1111-111111111111',
          after_boot_id: '22222222-2222-2222-2222-222222222222',
          same_instance: true,
          disk_marker_persisted: true,
          runtime_ready: true,
        },
      }),
      buildReleaseAcceptanceReport({
        suite: 'linux-installer',
        commitSha: commit,
        workflowRunUrl: runUrl,
        installerUrl,
        now,
      }),
    ],
  };
}

function suites(summary: Record<string, unknown>): Array<Record<string, unknown>> {
  return summary.suites as Array<Record<string, unknown>>;
}

describe('release acceptance evidence verifier', () => {
  it('accepts the exact three-suite, twenty-two-case proof', () => {
    const verified = verifyReleaseAcceptanceSummary(validSummary(), commit);
    expect(verified.suites.flatMap((suite) => suite.cases)).toHaveLength(22);
  });

  it.each([
    [
      'wrong summary commit',
      (summary: Record<string, unknown>) => (summary.commit_sha = 'b'.repeat(40)),
      'summary commit',
    ],
    ['missing suite', (summary: Record<string, unknown>) => suites(summary).pop(), 'acceptance suites'],
    [
      'different workflow run',
      (summary: Record<string, unknown>) => (suites(summary)[1].workflow_run_url = `${runUrl}0`),
      'different workflow runs',
    ],
    [
      'removed containment case',
      (summary: Record<string, unknown>) => (suites(summary)[0].cases as unknown[]).pop(),
      'incus-vm-containment cases',
    ],
    [
      'fabricated case id',
      (summary: Record<string, unknown>) =>
        ((suites(summary)[0].cases as Array<Record<string, unknown>>)[0].id = 'everything-is-secure'),
      'incus-vm-containment cases',
    ],
    [
      'unpassed case',
      (summary: Record<string, unknown>) =>
        ((suites(summary)[0].cases as Array<Record<string, unknown>>)[0].passed = false),
      'did not pass',
    ],
    [
      'moving installer URL',
      (summary: Record<string, unknown>) =>
        (suites(summary)[2].installer_url = 'https://raw.githubusercontent.com/aviatam/area51/main/install-linux.sh'),
      'not pinned',
    ],
    [
      'unchanged reboot id',
      (summary: Record<string, unknown>) => {
        const measurement = suites(summary)[1].vm_reboot_measurement as Record<string, unknown>;
        measurement.after_boot_id = measurement.before_boot_id;
      },
      'reboot measurement',
    ],
    [
      'hidden known gap',
      (summary: Record<string, unknown>) => {
        suites(summary)[2].not_covered = ['physical-host-reboot', 'real-provider-credentials'];
      },
      'live-entra-okta-authorization',
    ],
  ])('rejects %s', (_name, mutate, message) => {
    const summary = validSummary();
    mutate(summary);
    expect(() => verifyReleaseAcceptanceSummary(summary, commit)).toThrow(message);
  });
});
