import path from 'path';

import { describe, expect, it } from 'vitest';

import { buildIncusRuntimePlan, formatIncusRuntimePlan } from './incus-runtime.js';

describe('buildIncusRuntimePlan', () => {
  it('maps an agent group to an isolated Incus project and instance', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'Support Refund Agent',
      groupDir: path.join('tmp', 'support-agent'),
      sessionDir: path.join('tmp', 'session'),
    });

    expect(plan.project).toBe('area51-support-refund-agent');
    expect(plan.instance).toBe('area51-support-refund-agent-agent');
    expect(plan.profiles).toContain('area51-agent-net');
    expect(plan.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/workspace/agent', readonly: false }),
        expect.objectContaining({ path: '/workspace', readonly: false }),
      ]),
    );
    expect(plan.restrictions['security.privileged']).toBe('false');
    expect(plan.commands.quarantine).toEqual(
      expect.arrayContaining([
        expect.stringContaining('incus freeze area51-support-refund-agent-agent'),
        expect.stringContaining('incus profile add area51-support-refund-agent-agent area51-quarantine'),
      ]),
    );
  });

  it('formats a concise operator plan', () => {
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'demo', groupDir: '.' });

    expect(formatIncusRuntimePlan(plan)).toContain('Incus runtime: area51-demo/area51-demo-agent');
  });
});
