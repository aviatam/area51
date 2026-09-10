import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildReleaseAcceptanceReport, writeReleaseAcceptanceReport } from './release-acceptance-report.js';

const commitSha = 'a'.repeat(40);
const workflowRunUrl = 'https://github.com/aviatam/area51/actions/runs/123';
const vmRebootMeasurement = {
  schema: 'area51.incus_vm_reboot_measurement.v1' as const,
  instance: 'area51-vm-image-smoke-123',
  before_boot_id: '11111111-1111-1111-1111-111111111111',
  after_boot_id: '22222222-2222-2222-2222-222222222222',
  same_instance: true as const,
  disk_marker_persisted: true as const,
  runtime_ready: true as const,
};

describe('release acceptance report', () => {
  it('records the live VM hostile-containment cases without claiming an installer run', () => {
    const report = buildReleaseAcceptanceReport({
      suite: 'incus-vm-containment',
      commitSha,
      workflowRunUrl,
      now: new Date('2026-09-07T00:00:00Z'),
    });

    expect(report).toMatchObject({
      schema: 'area51.release_acceptance.v1',
      suite: 'incus-vm-containment',
      installer_url: null,
      passed: true,
      vm_reboot_measurement: null,
      not_covered: ['live-entra-okta-authorization', 'real-provider-credentials', 'physical-host-reboot'],
    });
    expect(report.cases).toHaveLength(9);
    expect(report.cases.every((testCase) => testCase.passed)).toBe(true);
  });

  it('requires the public installer URL to be pinned to the tested commit', () => {
    expect(() =>
      buildReleaseAcceptanceReport({
        suite: 'linux-installer',
        commitSha,
        workflowRunUrl,
        installerUrl: 'https://raw.githubusercontent.com/aviatam/area51/main/install-linux.sh',
      }),
    ).toThrow('installer URL is not pinned');
  });

  it('records same-VM reboot and runtime persistence without claiming a host reboot', () => {
    const report = buildReleaseAcceptanceReport({
      suite: 'incus-vm-reboot',
      commitSha,
      workflowRunUrl,
      vmRebootMeasurement,
      now: new Date('2026-09-07T00:00:00Z'),
    });

    expect(report).toMatchObject({
      suite: 'incus-vm-reboot',
      installer_url: null,
      passed: true,
      vm_reboot_measurement: vmRebootMeasurement,
      not_covered: ['live-entra-okta-authorization', 'real-provider-credentials', 'physical-host-reboot'],
    });
    expect(report.cases).toHaveLength(3);
  });

  it('rejects reboot evidence when the kernel boot ID did not change', () => {
    expect(() =>
      buildReleaseAcceptanceReport({
        suite: 'incus-vm-reboot',
        commitSha,
        workflowRunUrl,
        vmRebootMeasurement: {
          ...vmRebootMeasurement,
          after_boot_id: vmRebootMeasurement.before_boot_id,
        },
      }),
    ).toThrow('valid same-VM reboot measurement is required');
  });

  it('writes non-secret evidence with private file permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-release-acceptance-'));
    const output = path.join(root, 'report.json');
    const installerUrl = `https://raw.githubusercontent.com/aviatam/area51/${commitSha}/install-linux.sh`;
    const report = buildReleaseAcceptanceReport({
      suite: 'linux-installer',
      commitSha,
      workflowRunUrl,
      installerUrl,
    });

    writeReleaseAcceptanceReport(output, report);
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({ passed: true, installer_url: installerUrl });
    if (process.platform !== 'win32') expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
