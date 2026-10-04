import { randomUUID } from 'node:crypto';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const toolAction: McpToolDefinition = {
  tool: {
    name: 'tool_action',
    description:
      'Request a host-registered tool action. Host policy may deny it or require administrator approval. Results arrive as system messages. Never supply credentials.',
    inputSchema: {
      type: 'object' as const,
      properties: { tool: { type: 'string' }, args: { type: 'object' } },
      required: ['tool', 'args'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    if (
      Object.keys(args).sort().join(',') !== 'args,tool' ||
      typeof args.tool !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(args.tool) ||
      !args.args ||
      typeof args.args !== 'object' ||
      Array.isArray(args.args) ||
      Buffer.byteLength(JSON.stringify(args.args)) > 65_536
    )
      return { isError: true, content: [{ type: 'text', text: 'Invalid tool action request.' }] };
    const requestId = randomUUID();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'tool_action',
        tool: args.tool,
        args: args.args,
        requestId,
      }),
    });
    return {
      content: [
        { type: 'text', text: `Tool request ${requestId} submitted. Await the system result before resubmitting.` },
      ],
    };
  },
};
registerTools([toolAction]);
