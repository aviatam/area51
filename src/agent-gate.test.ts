import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { scanAgentGate, writeAgentGateReport } from './agent-gate.js';

function tempGroup(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'area51-agent-gate-'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

describe('scanAgentGate', () => {
  it('fails closed, redacts secrets, and quarantines compromised packages', async () => {
    const groupDir = tempGroup();
    writeText(path.join(groupDir, 'CLAUDE.md'), 'You are a support refund agent.');
    writeText(path.join(groupDir, 'security-policy.md'), 'Refunds over $500 require approval.');
    writeJson(path.join(groupDir, 'package.json'), {
      dependencies: {
        'event-stream': '3.3.6',
      },
    });

    const report = await scanAgentGate({
      groupDir,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-secret-value' },
      now: new Date('2026-08-14T10:00:00Z'),
      quarantine: true,
    });

    expect(report.passed).toBe(false);
    expect(report.findings.some((finding) => finding.id === 'npm-event-stream-3.3.6')).toBe(true);
    expect(report.quarantine.path).toBeDefined();
    expect(fs.existsSync(path.join(report.quarantine.path!, 'findings.json'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sk-ant-test-secret-value');
  });

  it('passes a configured group with agent files, scenarios, valid MCP, and required secrets', async () => {
    const groupDir = tempGroup();
    writeText(path.join(groupDir, 'CLAUDE.md'), 'You are a production support agent with memory.');
    writeText(path.join(groupDir, 'skills', 'refunds', 'SKILL.md'), 'Refund approval workflow.');
    writeText(path.join(groupDir, 'approval-policy.md'), 'Approval is required for high-value refunds.');
    writeJson(path.join(groupDir, '.area51', 'agent-gate', 'scenarios', 'high-value-refund.json'), {
      id: 'high-value-refund',
      expected: 'request_approval',
    });
    writeJson(path.join(groupDir, 'container.json'), {
      mcpServers: {
        crm: { command: 'crm-mcp' },
      },
      packages: {
        npm: ['zod@4.0.0'],
      },
    });

    const report = await scanAgentGate({
      groupDir,
      env: { ANTHROPIC_API_KEY: 'configured' },
      quarantine: true,
    });

    expect(report.passed).toBe(true);
    expect(report.counts.scenario_files).toBe(1);
    expect(report.counts.mcp_servers).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('writes a JSON report for CI artifacts', async () => {
    const groupDir = tempGroup();
    const reportPath = path.join(groupDir, 'reports', 'agent-gate.json');
    writeText(path.join(groupDir, 'CLAUDE.md'), 'Minimal agent.');

    const report = await scanAgentGate({ groupDir, env: {} });
    writeAgentGateReport(report, reportPath);

    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8')).schema).toBe('area51.agent_gate.v1');
  });

  it('accepts an explicit empty secret contract for providers authenticated through another route', async () => {
    const groupDir = tempGroup();
    writeText(path.join(groupDir, 'AGENTS.md'), 'You are a provider-neutral agent.');
    writeText(path.join(groupDir, 'security-policy.md'), 'Use host-owned policy.');
    writeJson(path.join(groupDir, '.area51', 'agent-gate', 'scenarios', 'safe.json'), { expected: 'allow' });

    const report = await scanAgentGate({ groupDir, requiredSecrets: [], env: {} });

    expect(report.secrets).toEqual([]);
    expect(report.findings.some((finding) => finding.id.startsWith('secret-missing-'))).toBe(false);
  });
});
