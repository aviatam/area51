import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { ToolBrokerVmFixture } from './tool-broker-vm-fixture.js';

async function execute(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('VM tool broker fixture', () => {
  it('runs the same guest probes and host approval assertions over real HTTP', async () => {
    const errors: Error[] = [];
    const fixture = new ToolBrokerVmFixture((error) => errors.push(error));
    try {
      await fixture.startControl();
      await once(fixture.startRelay('primary', '127.0.0.1', 0, 0), 'listening');
      await once(fixture.startRelay('peer', '127.0.0.1', 0), 'listening');
      // Local child processes share host networking; only the hosted VM test
      // can require the direct-backend egress probe to be blocked.
      const primary = await execute(fixture.guestProbe('primary', false));
      const peer = await execute(fixture.guestProbe('peer', false));
      expect(primary.code, primary.stderr).toBe(0);
      expect(peer.code, peer.stderr).toBe(0);
      const proof = await fixture.verifyApprovals(JSON.parse(primary.stdout), JSON.parse(peer.stdout));
      expect(proof).toMatchObject({
        upstream_count: 3,
        per_relay_identity_bound: true,
        exact_approval_passed: true,
        expired_approval_blocked: true,
      });
      expect(errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it('fails the egress assertion when the backend is reachable', async () => {
    const errors: Error[] = [];
    const fixture = new ToolBrokerVmFixture((error) => errors.push(error));
    try {
      await fixture.startControl();
      await once(fixture.startRelay('primary', '127.0.0.1', 0, 0), 'listening');
      const result = await execute(fixture.guestProbe('primary', true));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('guest reached direct tool backend');
      // Raw TCP alone must fail the probe, before an HTTP request can even be sent.
      expect(errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
