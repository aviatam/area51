import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { deploy, inspectDeployment } from '../scripts/deploy.js';

describe('governed bundle deployment', () => {
  it('has a portable contract preflight', () => {
    expect(
      inspectDeployment('contract')
        .filter((check) => check.required)
        .every((check) => check.passed),
    ).toBe(true);
  });

  it('deploys the contract bundle and writes a final deployment report', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-bundle-'));
    expect(await deploy(['--mode', 'contract', '--output-dir', outputDir])).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'reports', 'deployment.json'), 'utf8'));
    expect(report).toMatchObject({
      schema: 'area51.bundle_deployment.v1',
      mode: 'contract',
      phase: 'complete',
      deployment_passed: true,
    });
  });
});
