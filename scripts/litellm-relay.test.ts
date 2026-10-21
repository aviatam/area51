import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { litellmRelay } from '../.claude/skills/litellm-quarantine/relay.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture() {
  const fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) =>
    Response.json({ choices: [{ message: { content: 'Isolate secrets from agent code.' } }] }),
  );
  const statuses: number[] = [];
  const server = http.createServer(
    litellmRelay({
      token: 'demo-capability',
      key: 'host-only-key',
      fetcher: fetcher as typeof fetch,
      record: (s) => statuses.push(s),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const call = (body: unknown, token = 'demo-capability', route = '/v1/chat/completions') =>
    fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { call, fetcher, statuses };
}
const request = {
  model: 'area51-litellm-demo',
  messages: [
    { role: 'system', content: 'Help.' },
    { role: 'user', content: 'Why isolate?' },
  ],
};
it('serves two real-shaped LiteLLM requests with host credentials, fixed upstream and no write capability', async () => {
  const { call, fetcher, statuses } = await fixture();
  const response = await call({ ...request, api_base: 'http://attacker.invalid', api_key: 'attacker' });
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain('host-only-key');
  expect(fetcher.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  const upstream = fetcher.mock.calls[0][1] as RequestInit;
  expect(upstream.redirect).toBe('error');
  expect((upstream.headers as Record<string, string>).authorization).toBe('Bearer host-only-key');
  expect(JSON.parse(upstream.body as string)).not.toHaveProperty('tools');
  expect((await call(request)).status).toBe(200);
  expect((await call(request)).status).toBe(429);
  expect(statuses).toEqual([200, 200]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('denies bad identity, tools and alternate routes before reaching Groq', async () => {
  const { call, fetcher } = await fixture();
  expect((await call(request, 'wrong')).status).toBe(401);
  expect((await call(request, 'demo-capability', '/config/update')).status).toBe(404);
  expect((await call({ ...request, tools: [{}] })).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
