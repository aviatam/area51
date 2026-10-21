/** Bounded inference gateway. Only an ephemeral capability enters the VM. */
import type { RequestListener } from 'node:http';

export const MODEL = 'openai/gpt-oss-20b';
export const FUNCTION = {
  type: 'function',
  function: {
    name: 'area51__tool_action',
    description: 'Request a host action through Area51. Await the returned host status before reporting completion.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['groq_mvp_check'] },
        args: {
          type: 'object',
          properties: { title: { type: 'string', enum: ['Area51 MVP live demo'] } },
          required: ['title'],
          additionalProperties: false,
        },
      },
      required: ['tool', 'args'],
      additionalProperties: false,
    },
  },
};

export function validateMessages(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object' || Object.keys(body).join(',') !== 'messages') throw new Error('request');
  const messages = (body as { messages: unknown }).messages;
  if (!Array.isArray(messages) || messages.length < 2 || messages.length > 40) throw new Error('messages');
  if (JSON.stringify(messages).length > 32000) throw new Error('context budget');
  for (const message of messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
      (message.content !== null && typeof message.content !== 'string') ||
      Object.keys(message).some((key) => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(key))
    )
      throw new Error('message');
    if (
      message.tool_calls !== undefined &&
      (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length !== 1)
    )
      throw new Error('tool calls');
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') throw new Error('tool result');
  }
  return messages;
}

export function groqAgentGateway(input: {
  token: string;
  key: string;
  record: (event: { status: number; modelCall: number }) => void;
  fetcher?: typeof fetch;
}): RequestListener {
  let calls = 0;
  let busy = false;
  const fetcher = input.fetcher ?? fetch;
  return (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/groq-demo/propose') return reply(405, { error: 'route' });
      if (request.headers.authorization !== `Bearer ${input.token}`) return reply(401, { error: 'identity' });
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 40000) return reply(413, { error: 'size' });
      }
      let messages;
      try {
        messages = validateMessages(JSON.parse(raw));
      } catch (_error) {
        return reply(400, { error: 'request' });
      }
      if (busy) return reply(409, { error: 'busy' });
      if (calls >= 16) return reply(429, { error: 'session budget' });
      busy = true;
      try {
        let upstream: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          calls++;
          upstream = await fetcher('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { authorization: `Bearer ${input.key}`, 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(45000),
            body: JSON.stringify({
              model: MODEL,
              messages,
              tools: [FUNCTION],
              tool_choice: 'auto',
              parallel_tool_calls: false,
              temperature: 0,
              max_completion_tokens: 1024,
              reasoning_effort: 'low',
            }),
          });
          input.record({ status: upstream.status, modelCall: calls });
          if (upstream.status !== 429 || attempt === 1) break;
          await upstream.body?.cancel();
          // Inference only: never use this retry mechanism for an external write.
          const seconds = Number(upstream.headers.get('retry-after') ?? '20');
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(30, Math.max(1, Number.isFinite(seconds) ? seconds : 20)) * 1000),
          );
        }
        if (!upstream?.ok) return reply(502, { error: 'model unavailable' });
        const rawReply = await upstream.text();
        if (rawReply.length > 32000) return reply(502, { error: 'model response budget' });
        const message = JSON.parse(rawReply).choices?.[0]?.message;
        if (
          !message ||
          message.role !== 'assistant' ||
          (message.content !== null && typeof message.content !== 'string')
        )
          return reply(502, { error: 'model response' });
        const result: Record<string, unknown> = { role: 'assistant', content: message.content };
        if (message.tool_calls?.length) {
          if (message.tool_calls.length !== 1) return reply(502, { error: 'tool count' });
          const call = message.tool_calls[0];
          if (
            call.type !== 'function' ||
            call.function?.name !== FUNCTION.function.name ||
            typeof call.id !== 'string' ||
            typeof call.function.arguments !== 'string' ||
            call.function.arguments.length > 2048
          )
            return reply(502, { error: 'model tool' });
          result.tool_calls = [
            {
              id: call.id,
              type: 'function',
              function: { name: call.function.name, arguments: call.function.arguments },
            },
          ];
        }
        return reply(200, result);
      } finally {
        busy = false;
      }
    })().catch((_error) => reply(502, { error: 'model unavailable' }));
  };
}
