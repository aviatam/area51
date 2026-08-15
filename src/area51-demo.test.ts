import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { formatArea51DemoReport, runArea51Demo } from './area51-demo.js';

describe('runArea51Demo', () => {
  it('creates a working fail-closed NanoClaw + Incus demo', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-demo-test-'));

    const report = await runArea51Demo({
      outputDir,
      now: new Date('2026-08-15T05:00:00Z'),
    });

    expect(report.schema).toBe('area51.demo.v1');
    expect(report.agent_gate_report.passed).toBe(false);
    expect(report.agent_gate_report.findings.some((finding) => finding.id === 'npm-event-stream-3.3.6')).toBe(true);
    expect(report.incus_runtime_plan.project).toBe('area51-support-refund-agent');
    expect(report.verified).toEqual({
      agent_gate_failed_closed: true,
      quarantine_artifacts_written: true,
      incus_quarantine_flow_planned: true,
    });
    expect(fs.existsSync(path.join(outputDir, 'reports', 'agent-gate.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'reports', 'incus-runtime-plan.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'reports', 'area51-demo.json'))).toBe(true);
  });

  it('formats verification status for the CLI', async () => {
    const report = await runArea51Demo({
      outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'area51-demo-format-')),
      now: new Date('2026-08-15T05:00:00Z'),
    });

    expect(formatArea51DemoReport(report)).toContain('Area51 demo: VERIFIED');
  });
});
