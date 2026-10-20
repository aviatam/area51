import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { modelGateway } from './groq-vm-proof.js';
import { ToolBrokerVmFixture } from './tool-broker-vm-fixture.js';
import type { Proposal } from './mvp-groq-demo.js';

const proposal: Proposal = {
  schema: 'area51.groq-demo.v1',
  context: { repo: 'aviatam/area51', sha: 'a'.repeat(40), run: '123', attempt: '1' },
  model: 'openai/gpt-oss-20b',
  tool: 'create_neutral_check',
  args: { title: 'VM demo' },
};
async function withGateway(
  generate: () => Promise<Proposal>,
  check: (url: string, failed: () => boolean) => Promise<void>,
) {
  let failed = false;
  const server = http.createServer(
    modelGateway({
      token: 'synthetic-relay-token',
      prompt: 'VM demo',
      generate,
      onFailure: () => {
        failed = true;
      },
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  try {
    await check(`http://127.0.0.1:${address.port}/groq-demo/propose`, () => failed);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function call(url: string, body: unknown = { prompt: 'VM demo' }, token = 'synthetic-relay-token') {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
describe('Groq VM gateway', () => {
  it('authenticates, fixes the prompt and consumes exactly one model request', async () => {
    const generate = vi.fn().mockResolvedValue(proposal);
    await withGateway(generate, async (url, failed) => {
      expect((await call(url, undefined, 'wrong-token')).status).toBe(401);
      expect((await call(url, { prompt: 'other' })).status).toBe(400);
      expect((await call(url, { prompt: 'VM demo', url: 'https://evil.test' })).status).toBe(400);
      const response = await call(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(proposal);
      expect((await call(url)).status).toBe(409);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(failed()).toBe(false);
    });
  });
  it('consumes before awaiting the provider, including concurrent requests', async () => {
    let complete!: (p: Proposal) => void;
    const generate = vi.fn(
      () =>
        new Promise<Proposal>((resolve) => {
          complete = resolve;
        }),
    );
    await withGateway(generate, async (url) => {
      const first = call(url);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      const second = await call(url);
      expect(second.status).toBe(409);
      complete(proposal);
      expect((await first).status).toBe(200);
    });
  });
  it('withholds provider errors and refuses retry after a provider failure', async () => {
    await withGateway(
      async () => {
        throw new Error('private-provider-key');
      },
      async (url, failed) => {
        const response = await call(url);
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain('private-provider-key');
        expect((await call(url)).status).toBe(409);
        expect(failed()).toBe(true);
      },
    );
  });
  it('rejects wrong methods, invalid JSON and oversized requests', async () => {
    const generate = vi.fn().mockResolvedValue(proposal);
    await withGateway(generate, async (url) => {
      expect((await fetch(url)).status).toBe(405);
      const headers = { authorization: 'Bearer synthetic-relay-token' };
      expect((await fetch(url, { method: 'POST', headers, body: '{' })).status).toBe(400);
      expect((await call(url, { prompt: 'x'.repeat(4096) })).status).toBe(413);
      expect(generate).not.toHaveBeenCalled();
    });
  });
  it('exposes the optional model route only on the primary relay', async () => {
    const errors: Error[] = [];
    const fixture = new ToolBrokerVmFixture((error) => errors.push(error));
    const handler = vi.fn<http.RequestListener>((_req, res) => {
      res.end('primary-model-only');
    });
    fixture.setModelHandler(handler);
    const primary = fixture.startRelay('primary', '127.0.0.1', 0, 0);
    const peer = fixture.startRelay('peer', '127.0.0.1', 0);
    await Promise.all([once(primary, 'listening'), once(peer, 'listening')]);
    try {
      for (const [server, accepted] of [
        [primary, true],
        [peer, false],
      ] as const) {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing listener');
        const response = await fetch(`http://127.0.0.1:${address.port}/groq-demo/propose`, { method: 'POST' });
        expect(response.status).toBe(accepted ? 200 : 401);
      }
      expect(handler).toHaveBeenCalledTimes(1);
      fixture.setModelHandler(undefined);
      expect(errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
  it('never injects provider secrets into image building or pull-request runs', () => {
    const workflow = parse(fs.readFileSync('.github/workflows/groq-vm-proof.yml', 'utf8'));
    const job = workflow.jobs['vm-proof'];
    expect(job.if).toContain("github.event_name == 'push'");
    expect(job.if).toContain("github.ref == 'refs/heads/test/groq-vm-proof'");
    expect(job.if).toContain("github.actor == 'aviatam'");
    expect(job.permissions).toEqual({ contents: 'read', checks: 'write' });
    const secretSteps = job.steps.filter((s: { env?: Record<string, string> }) => s.env?.GROQ_API_KEY);
    expect(secretSteps).toHaveLength(1);
    expect(secretSteps[0].name).toBe('Run three real Groq VM trials');
    expect(secretSteps[0].env.AREA51_GROQ_VM_PROOF).toBe('1');
  });
});
