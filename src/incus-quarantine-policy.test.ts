import { describe, expect, it, vi } from 'vitest';

import type { AgentGateReport } from './agent-gate.js';
import { enforceIncusPreflight, enforceIncusRuntimeDecision } from './incus-quarantine-policy.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';

describe('Incus live quarantine policy', () => {
  it('freezes and snapshots a live instance when Agent Gate produced quarantine evidence', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'support', groupDir: '/srv/groups/support' });

    const result = enforceIncusPreflight(report(true), plan, { executor });

    expect(result.decision.action).toBe('quarantine');
    expect(executor).toHaveBeenCalledWith(['freeze', plan.instance, '--project', plan.project]);
    expect(executor).toHaveBeenCalledWith(expect.arrayContaining(['snapshot', 'create', plan.instance]));
    expect(result.quarantine?.commands.every((command) => command.ok)).toBe(true);
  });

  it('does not mutate the instance for a clean report', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'support', groupDir: '/srv/groups/support' });

    const result = enforceIncusPreflight(report(false), plan, { executor });

    expect(result.decision.action).toBe('allow');
    expect(executor).not.toHaveBeenCalled();
  });

  it('refuses to apply a container decision to a VM plan', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/groups/support',
      instanceKind: 'vm',
      mounts: [],
      vmNetwork: {
        network: 'support-net',
        acl: 'support-acl',
        ipv4Cidr: '10.90.0.1/24',
        oneCliAddress: '10.90.0.1',
        oneCliPort: 10255,
      },
      vmDisks: {
        pool: 'default',
        volumes: [
          { name: 'support-workspace', source: '/srv/session', path: '/workspace', readonly: false, size: '1GiB' },
        ],
      },
    });

    expect(() =>
      enforceIncusRuntimeDecision(
        {
          schema: 'area51.runtime_policy.v1',
          action: 'allow',
          runtime: 'incus-container',
          riskScore: 50,
          requiresIncus: true,
          quarantineRequired: false,
          reasons: ['production'],
          controls: [],
        },
        plan,
      ),
    ).toThrow('refusing incus-vm');
  });
});

function report(compromised: boolean): AgentGateReport {
  return {
    schema: 'area51.agent_gate.v1',
    generated_at: '2026-08-21T00:00:00.000Z',
    group_path: '/srv/groups/support',
    passed: !compromised,
    overall_fitness_index: compromised ? 20 : 100,
    thresholds: { minimum_overall: 70, fail_on_warnings: false },
    counts: {
      files_scanned: 1,
      agent_files: 1,
      policy_files: 1,
      scenario_files: 1,
      mcp_servers: 0,
      packages: compromised ? 1 : 0,
      findings: compromised ? 1 : 0,
      high_findings: compromised ? 1 : 0,
    },
    secrets: [],
    pillars: {
      capabilities: { score: 100, status: 'pass', highlights: [] },
      evolution: { score: 100, status: 'pass', highlights: [] },
      skill_efficiency: { score: compromised ? 0 : 100, status: compromised ? 'fail' : 'pass', highlights: [] },
      integration: { score: 100, status: 'pass', highlights: [] },
      security: { score: compromised ? 0 : 100, status: compromised ? 'fail' : 'pass', highlights: [] },
    },
    findings: compromised
      ? [
          {
            id: 'package-risk',
            severity: 'high',
            pillar: 'security',
            title: 'Compromised package',
            detail: 'Compromised package evidence was found',
            evidence: ['bad-package'],
            recommendation: 'quarantine',
          },
        ]
      : [],
    quarantine: compromised
      ? {
          enabled: true,
          path: '/srv/groups/support/quarantine',
          files: ['/srv/groups/support/quarantine/findings.json'],
        }
      : { enabled: true, files: [] },
    recommendations: compromised ? ['quarantine'] : [],
  };
}
