import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runGovernedDemo } from '../scripts/run.js';

describe('governed escalation demo', () => {
  it('proves a clean-to-poisoned fresh policy decision and VM quarantine contract', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-governed-demo-'));
    const result = await runGovernedDemo(outputDir, new Date('2026-08-29T12:00:00Z'));
    expect(result.assertions.every((assertion) => assertion.passed)).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'reports', 'assertions.json'), 'utf8'));
    expect(report).toMatchObject({
      schema: 'area51.governed_demo.v1',
      mode: 'deterministic-contract',
      passed: true,
    });
    expect(fs.readFileSync(path.join(outputDir, 'README.md'), 'utf8')).toContain('did not claim live Incus execution');
  });
});
