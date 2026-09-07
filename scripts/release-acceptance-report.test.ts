import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildReleaseAcceptanceReport, writeReleaseAcceptanceReport } from './release-acceptance-report.js';

const commitSha = 'a'.repeat(40);
const workflowRunUrl = 'https://github.com/aviatam/area51/actions/runs/123';

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
