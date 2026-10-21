import { timingSafeEqual } from 'node:crypto';
import type { RequestListener } from 'node:http';

/** A two-request inference-only adapter: no caller-controlled URL, model, tools, or credentials. */
export function litellmRelay(input: {
  token: string;
  key: string;
  fetcher?: typeof fetch;
  record: (status: number) => void;
}): RequestListener {
  let calls = 0;
  return (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      const auth = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${input.token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, { error: 'identity' });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return reply(404, { error: 'route' });
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 16000) return reply(413, { error: 'budget' });
      }
      const body = JSON.parse(raw);
      const messages = body.messages;
      if (
        body.model !== 'area51-litellm-demo' ||
        !Array.isArray(messages) ||
        messages.length < 2 ||
        messages.length > 4 ||
        messages.some(
          (m) =>
            !m ||
            !['system', 'user', 'assistant'].includes(m.role) ||
            typeof m.content !== 'string' ||
            Object.keys(m).some((k) => !['role', 'content'].includes(k)),
        ) ||
        body.tools ||
        body.stream ||
        body.functions
      )
        return reply(400, { error: 'request' });
      if (++calls > 2) return reply(429, { error: 'budget' });
      const upstream = await (input.fetcher ?? fetch)('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(45000),
        headers: { authorization: `Bearer ${input.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages,
          temperature: 0,
          max_completion_tokens: 1024,
          reasoning_effort: 'low',
        }),
      });
      input.record(upstream.status);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply(502, { error: 'inference unavailable' });
      }
      const data = (await upstream.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim() || content.length > 8000)
        return reply(502, { error: 'invalid inference' });
      reply(200, {
        id: `area51-litellm-${calls}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'area51-litellm-demo',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    })().catch(() => reply(502, { error: 'inference unavailable' }));
  };
}
