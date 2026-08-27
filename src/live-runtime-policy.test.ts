import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentGateReport } from './agent-gate.js';
import type { ContainerConfig } from './container-config.js';
import { selectLiveRuntimePolicy, writeLiveRuntimePolicyDecision } from './live-runtime-policy.js';

describe('live runtime policy', () => {
  it('keeps a clean local group on Docker', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config(),
    });

    expect(decision).toMatchObject({ action: 'allow', runtime: 'docker', requiresIncus: false });
  });

  it('does not break a default local group that still lacks policy and scenario files', () => {
    const report = cleanReport();
    report.passed = false;
    report.overall_fitness_index = 70;
    report.findings = [warning('policy-files-missing'), warning('behavior-scenarios-missing')];
    report.counts.findings = 2;
    const decision = selectLiveRuntimePolicy(report, {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config(),
    });

    expect(decision).toMatchObject({ action: 'allow', runtime: 'docker' });
    expect(decision.riskScore).toBeLessThan(50);
  });

  it('blocks risky local packages instead of falling back to Docker', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config({ packages: { apt: [], npm: ['third-party-tool'] } }),
    });

    expect(decision.action).toBe('block');
    expect(decision.runtime).toBeUndefined();
    expect(decision.reasons).toContain('Incus is required by policy but is not available');
  });

  it('blocks an unowned MCP server on Docker because its provenance is unknown', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config({ mcpServers: { crm: { command: 'crm-mcp' } } }),
    });

    expect(decision).toMatchObject({ action: 'block', requiresIncus: true });
    expect(decision.reasons).toContain('unknown agent or skill source');
    expect(decision.reasons).toContain('high-risk capability requested: shell');
  });

  it('blocks a plugin-owned MCP server on Docker as third-party code', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config({
        mcpServers: { crm: { command: 'crm-mcp' } },
        mcpServerProvenance: { crm: 'sales' },
      }),
    });

    expect(decision).toMatchObject({ action: 'block', requiresIncus: true });
    expect(decision.reasons).toContain('third-party agent or skill source');
  });

  it('escalates an unknown effective provider to an Incus VM', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'incus',
      incusInstanceKind: 'container',
      containerConfig: config(),
      provider: 'unregistered-provider',
    });

    expect(decision).toMatchObject({ action: 'allow', runtime: 'incus-vm' });
    expect(decision.reasons).toContain('unknown agent or skill source');
  });

  it('blocks an explicitly selected skill outside the built-in catalog on Docker', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config({ skills: ['unreviewed-skill'] }),
    });

    expect(decision).toMatchObject({ action: 'block', requiresIncus: true });
    expect(decision.reasons).toContain('unknown agent or skill source');
  });

  it('keeps an explicitly selected built-in skill on the clean default path', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'docker',
      incusInstanceKind: 'container',
      containerConfig: config({ skills: ['welcome'] }),
    });

    expect(decision).toMatchObject({ action: 'allow', runtime: 'docker', riskScore: 0 });
  });

  it('uses an Incus container for the normal production posture', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'incus',
      incusInstanceKind: 'container',
      containerConfig: config(),
    });

    expect(decision).toMatchObject({ action: 'allow', runtime: 'incus-container', requiresIncus: true });
  });

  it('escalates a broad package-installing production group to a VM', () => {
    const decision = selectLiveRuntimePolicy(cleanReport(), {
      backend: 'incus',
      incusInstanceKind: 'container',
      containerConfig: config({
        packages: { apt: ['git'], npm: ['third-party-tool'] },
        additionalMounts: [{ hostPath: '/srv/project', containerPath: '/project' }],
      }),
    });

    expect(decision).toMatchObject({ action: 'allow', runtime: 'incus-vm' });
  });

  it('keeps quarantine evidence inside the maximum-isolation VM posture', () => {
    const report = cleanReport();
    report.passed = false;
    report.quarantine.files = ['/groups/support/.area51/quarantine/findings.json'];
    const decision = selectLiveRuntimePolicy(report, {
      backend: 'incus',
      incusInstanceKind: 'vm',
      containerConfig: config(),
    });

    expect(decision).toMatchObject({ action: 'quarantine', runtime: 'incus-vm', quarantineRequired: true });
  });

  it('writes a private host-owned decision record atomically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-live-policy-'));
    try {
      const decision = selectLiveRuntimePolicy(cleanReport(), {
        backend: 'docker',
        incusInstanceKind: 'container',
        containerConfig: config(),
      });
      const destination = writeLiveRuntimePolicyDecision(root, 'session-1', decision);

      expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual(decision);
      expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.dirname(destination))).toEqual(['session-1.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function config(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    ...overrides,
  };
}

function cleanReport(): AgentGateReport {
  return {
    schema: 'area51.agent_gate.v1',
    generated_at: '2026-08-24T00:00:00.000Z',
    group_path: '/groups/support',
    passed: true,
    overall_fitness_index: 100,
    thresholds: { minimum_overall: 80, fail_on_warnings: false },
    counts: {
      files_scanned: 3,
      agent_files: 1,
      policy_files: 1,
      scenario_files: 1,
      mcp_servers: 0,
      packages: 0,
      findings: 0,
      high_findings: 0,
    },
    secrets: [{ name: 'ANTHROPIC_API_KEY', present: true, source: 'environment' }],
    pillars: {
      capabilities: { score: 100, status: 'pass', highlights: [] },
      evolution: { score: 100, status: 'pass', highlights: [] },
      skill_efficiency: { score: 100, status: 'pass', highlights: [] },
      integration: { score: 100, status: 'pass', highlights: [] },
      security: { score: 100, status: 'pass', highlights: [] },
    },
    findings: [],
    quarantine: { enabled: true, files: [] },
    recommendations: [],
  };
}

function warning(id: string): AgentGateReport['findings'][number] {
  return {
    id,
    severity: 'warning',
    pillar: 'security',
    title: id,
    detail: id,
    evidence: [],
    recommendation: id,
  };
}
