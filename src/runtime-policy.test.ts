import { describe, expect, it } from 'vitest';

import type { AgentGateReport } from './agent-gate.js';
import { selectRuntimePolicy } from './runtime-policy.js';

describe('selectRuntimePolicy', () => {
  it('keeps low-risk local work on Docker for developer compatibility', () => {
    const decision = selectRuntimePolicy(cleanReport(), {
      profile: 'local',
      trustLevel: 'approved',
      dataSensitivity: 'low',
      capabilities: ['chat'],
      incusAvailable: false,
    });

    expect(decision.action).toBe('allow');
    expect(decision.runtime).toBe('docker');
    expect(decision.requiresIncus).toBe(false);
    expect(decision.quarantineRequired).toBe(false);
  });

  it('uses Incus containers for production work when Incus is available', () => {
    const decision = selectRuntimePolicy(cleanReport(), {
      profile: 'production',
      trustLevel: 'approved',
      dataSensitivity: 'business',
      capabilities: ['chat', 'network'],
      incusAvailable: true,
    });

    expect(decision.action).toBe('allow');
    expect(decision.runtime).toBe('incus-container');
    expect(decision.requiresIncus).toBe(true);
    expect(decision.controls).toContain('isolated Incus project');
  });

  it('uses Incus VMs for maximum isolation', () => {
    const decision = selectRuntimePolicy(cleanReport(), {
      profile: 'maximum',
      trustLevel: 'approved',
      dataSensitivity: 'customer',
      capabilities: ['chat'],
      incusAvailable: true,
    });

    expect(decision.action).toBe('allow');
    expect(decision.runtime).toBe('incus-vm');
    expect(decision.requiresIncus).toBe(true);
  });

  it('blocks production workloads that require Incus when Incus is unavailable', () => {
    const decision = selectRuntimePolicy(cleanReport(), {
      profile: 'production',
      trustLevel: 'third-party',
      dataSensitivity: 'customer',
      capabilities: ['shell'],
      incusAvailable: false,
      allowDockerFallback: false,
    });

    expect(decision.action).toBe('block');
    expect(decision.runtime).toBeUndefined();
    expect(decision.requiresIncus).toBe(true);
    expect(decision.reasons).toContain('Incus is required by policy but is not available');
  });

  it('quarantines compromised package evidence through Incus when available', () => {
    const decision = selectRuntimePolicy(compromisedPackageReport(), {
      profile: 'production',
      trustLevel: 'approved',
      dataSensitivity: 'business',
      capabilities: ['package-install'],
      incusAvailable: true,
    });

    expect(decision.action).toBe('quarantine');
    expect(decision.runtime).toBe('incus-container');
    expect(decision.riskScore).toBe(100);
    expect(decision.quarantineRequired).toBe(true);
    expect(decision.controls).toContain('snapshot evidence');
  });

  it('quarantines maximum-profile evidence inside a VM', () => {
    const decision = selectRuntimePolicy(compromisedPackageReport(), {
      profile: 'maximum',
      trustLevel: 'approved',
      dataSensitivity: 'business',
      capabilities: ['package-install'],
      incusAvailable: true,
    });

    expect(decision.action).toBe('quarantine');
    expect(decision.runtime).toBe('incus-vm');
  });

  it('fails closed instead of pretending quarantine works without Incus', () => {
    const decision = selectRuntimePolicy(compromisedPackageReport(), {
      profile: 'production',
      trustLevel: 'approved',
      dataSensitivity: 'business',
      capabilities: ['package-install'],
      incusAvailable: false,
      allowDockerFallback: false,
    });

    expect(decision.action).toBe('block');
    expect(decision.runtime).toBeUndefined();
    expect(decision.requiresIncus).toBe(true);
    expect(decision.quarantineRequired).toBe(true);
  });
});

function cleanReport(): AgentGateReport {
  return {
    schema: 'area51.agent_gate.v1',
    generated_at: '2026-08-15T00:00:00.000Z',
    group_path: '/groups/support',
    passed: true,
    overall_fitness_index: 94,
    thresholds: {
      minimum_overall: 80,
      fail_on_warnings: false,
    },
    counts: {
      files_scanned: 6,
      agent_files: 1,
      policy_files: 1,
      scenario_files: 2,
      mcp_servers: 1,
      packages: 3,
      findings: 0,
      high_findings: 0,
    },
    secrets: [{ name: 'ANTHROPIC_API_KEY', present: true, source: 'environment' }],
    pillars: {
      capabilities: { score: 95, status: 'pass', highlights: [] },
      evolution: { score: 85, status: 'pass', highlights: [] },
      skill_efficiency: { score: 90, status: 'pass', highlights: [] },
      integration: { score: 92, status: 'pass', highlights: [] },
      security: { score: 100, status: 'pass', highlights: [] },
    },
    findings: [],
    quarantine: {
      enabled: true,
      files: [],
    },
    recommendations: [],
  };
}

function compromisedPackageReport(): AgentGateReport {
  return {
    ...cleanReport(),
    passed: false,
    overall_fitness_index: 62,
    counts: {
      ...cleanReport().counts,
      findings: 1,
      high_findings: 1,
    },
    findings: [
      {
        id: 'npm-event-stream-3.3.6',
        severity: 'high',
        pillar: 'security',
        title: 'Compromised npm package detected',
        detail: 'event-stream 3.3.6 is a known compromised release and must not be present in an agent image.',
        evidence: ['package.json:dependencies'],
        recommendation: 'Remove event-stream 3.3.6 and rebuild the group container image.',
      },
    ],
    quarantine: {
      enabled: true,
      path: '/groups/support/.area51/agent-gate/quarantine/2026',
      files: ['/groups/support/.area51/agent-gate/quarantine/2026/findings.json'],
    },
  };
}
