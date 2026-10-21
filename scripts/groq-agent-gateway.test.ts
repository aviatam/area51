import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { groqAgentGateway, validateMessages, MODEL } from './groq-agent-gateway.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('bounded host model gateway', () => {
  it('rejects model/URL overrides and malformed contexts', () => {
    for (const body of [
      null,
      { messages: [] },
      { messages: [{ role: 'user', content: 'x' }] },
      {
        messages: [
          { role: 'system', content: 'x' },
          { role: 'user', content: 'y' },
        ],
        model: 'override',
      },
      {
        messages: [
          { role: 'system', content: 'x' },
          { role: 'user', content: 'y', url: 'https://evil.invalid' },
        ],
      },
    ])
      expect(() => validateMessages(body)).toThrow();
  });

  it('authenticates before upstream calls, fixes request fields, strips upstream metadata and limits calls', async () => {
    const upstream: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const handler = groqAgentGateway({
      token: 'synthetic-relay',
      key: 'synthetic-host',
      record: () => {},
      fetcher: (async (url, options) => {
        upstream.push({
          url: String(url),
          body: JSON.parse(String(options!.body)),
          authorization: new Headers(options!.headers).get('authorization'),
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'hello', reasoning: 'private reasoning' } }],
          }),
        );
      }) as typeof fetch,
    });
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${port}/groq-demo/propose`;
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'demo' },
        { role: 'user', content: 'hello' },
      ],
    });
    const call = (token: string, data = body) =>
      fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: data });
    expect((await call('wrong')).status).toBe(401);
    expect((await call('synthetic-relay', '{')).status).toBe(400);
    expect(upstream.length).toBe(0);
    const result = await call('synthetic-relay');
    expect(await result.json()).toEqual({ role: 'assistant', content: 'hello' });
    expect(upstream[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(upstream[0].body.model).toBe(MODEL);
    expect(upstream[0].authorization).toBe('Bearer synthetic-host');
    expect(JSON.stringify(upstream[0].body)).not.toContain('synthetic-relay');
    for (let count = 1; count < 16; count++) expect((await call('synthetic-relay')).status).toBe(200);
    expect((await call('synthetic-relay')).status).toBe(429);
    expect(upstream.length).toBe(16);
  });
});
