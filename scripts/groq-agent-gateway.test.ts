import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { groqAgentGateway, validateMessages, MODEL } from './groq-agent-gateway.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('bounded host model gateway', () => {
  it('normalizes a real Groq pure tool-call response with omitted content', async () => {
    const toolCall = {
      id: 'call-1',
      type: 'function',
      function: {
        name: 'area51__tool_action',
        arguments: JSON.stringify({ tool: 'groq_mvp_check', args: { title: 'Area51 MVP live demo' } }),
      },
    };
    const events: Array<{ contentType?: string; toolCalls?: number }> = [];
    const server = createServer(
      groqAgentGateway({
        token: 'synthetic',
        key: 'host-only',
        record: (event) => events.push(event),
        fetcher: (async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [toolCall] } }],
            }),
          )) as typeof fetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/groq-demo/propose`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'demo' },
          { role: 'user', content: 'Action' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: 'assistant', content: null, tool_calls: [toolCall] });
    expect(events[0].contentType).toBe('undefined');
    expect(events[0].toolCalls).toBe(1);
  });

  it('does not spend a seventeenth inference request on a rate-limit retry', async () => {
    let calls = 0;
    const server = createServer(
      groqAgentGateway({
        token: 'synthetic-relay',
        key: 'synthetic-host',
        record: () => {},
        fetcher: (async () => {
          if (++calls === 16) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
          return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        }) as typeof fetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    for (let index = 1; index <= 16; index++) {
      const response = await fetch(`http://127.0.0.1:${port}/groq-demo/propose`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-relay' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'demo' },
            { role: 'user', content: 'hello' },
          ],
        }),
      });
      expect(response.status).toBe(index === 16 ? 502 : 200);
    }
    expect(calls).toBe(16);
  });

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
