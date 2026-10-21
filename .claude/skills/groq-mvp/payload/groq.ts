import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerProvider } from './provider-registry.js';
import { getPendingMessages, markCompleted } from '../db/messages-in.js';
import { getAllDestinations } from '../destinations.js';
import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Call[];
  tool_call_id?: string;
};
type History = { continuation: string; messages: Message[]; interrupted: boolean };
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Normal runner provider; inference and real credentials belong to the host gateway. */
export class GroqProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private memory = false;
  constructor(private readonly options: ProviderOptions) {
    if (options.model && options.model !== 'openai/gpt-oss-20b') throw new Error('Unsupported Groq MVP model');
    if (Object.keys(options.mcpServers ?? {}).some((key) => key !== 'area51'))
      throw new Error('Groq MVP supports only the built-in area51 MCP server');
  }
  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {
    this.memory = true;
  }
  isSessionInvalid(_error: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const queue = [input.prompt];
    const controller = new AbortController();
    let ended = false;
    let wake: (() => void) | undefined;
    const options = this.options;
    const memory = this.memory;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        let client: Client | undefined;
        let stage = 'configuration';
        try {
          const endpoint = options.env?.AREA51_GROQ_RELAY_URL;
          const token = options.env?.AREA51_GROQ_RELAY_TOKEN;
          if (!endpoint || !token) throw new Error('Missing host model gateway capability');
          const url = new URL(endpoint);
          if (
            url.protocol !== 'http:' ||
            !['10.251.0.1', '127.0.0.1'].includes(url.hostname) ||
            url.pathname !== '/groq-demo/propose' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error('Invalid host model gateway');
          const historyPath = options.env?.AREA51_GROQ_HISTORY_PATH ?? '/workspace/groq-history.json';
          let history: History;
          if (input.continuation) {
            if (!/^groq_[0-9a-f-]{36}$/.test(input.continuation)) throw new Error('Invalid Groq continuation');
            const saved = fs.readFileSync(historyPath, 'utf8');
            if (saved.length > 40000) throw new Error('Groq history exceeds MVP budget');
            history = JSON.parse(saved) as History;
            if (history.continuation !== input.continuation || !Array.isArray(history.messages))
              throw new Error('Missing Groq continuation history');
            if (history.interrupted)
              throw new Error('Interrupted tool outcome: host reconciliation required; no retry');
          } else {
            history = {
              continuation: `groq_${randomUUID()}`,
              interrupted: false,
              messages: [
                {
                  role: 'system',
                  content: [
                    input.systemContext?.instructions ?? '',
                    'You are the Area51 MVP assistant. Reply using <message to="destination-name">...</message> with the destination in the user message and runtime instructions.',
                    'Use area51__tool_action only when the user requests a host action. For the demo the host offers groq_mvp_check with args {"title":"Area51 MVP live demo"}.',
                    'Wait for the tool result. Report the actual status and exact public check URL. Never invent execution or retry an uncertain write.',
                    memory ? (memoryContextForSessionStart('startup', input.cwd) ?? '') : '',
                  ].join('\n'),
                },
              ],
            };
          }
          const save = () => {
            const value = JSON.stringify(history);
            if (value.length > 40000) throw new Error('Groq history exceeds MVP budget; start a new session');
            fs.writeFileSync(`${historyPath}.tmp`, value, { mode: 0o600 });
            fs.renameSync(`${historyPath}.tmp`, historyPath);
          };
          save();
          yield { type: 'init', continuation: history.continuation };
          while (!controller.signal.aborted) {
            if (!queue.length) {
              if (ended) break;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
              continue;
            }
            history.messages.push({ role: 'user', content: queue.shift()! });
            save();
            let completed = false;
            let hostConfirmation: string | undefined;
            for (let round = 0; round < 6; round++) {
              stage = 'model';
              yield { type: 'activity' };
              const response = await fetch(url, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ messages: history.messages }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
              });
              if (!response.ok) {
                stage = `gateway-${response.status}`;
                throw new Error('Host model gateway rejected the request');
              }
              stage = 'model-decode';
              const text = await response.text();
              if (text.length > 16000) throw new Error('Model response exceeds budget');
              const reply = JSON.parse(text) as Message;
              if (reply.role !== 'assistant' || (reply.content !== null && typeof reply.content !== 'string'))
                throw new Error('Invalid model response');
              history.messages.push(reply);
              const calls = reply.tool_calls ?? [];
              if (calls.length === 0) {
                stage = 'empty-model-result';
                if (!reply.content?.trim() && hostConfirmation) {
                  const destinations = getAllDestinations();
                  if (destinations.length !== 1) throw new Error('Cannot route a host confirmation unambiguously');
                  // A definitive host receipt remains usable when inference
                  // returns no final text. Label its source and never rerun MCP.
                  reply.content = `<message to="${xml(destinations[0].name)}">Host confirmation: ${xml(hostConfirmation)}</message>`;
                }
                if (!reply.content?.trim()) throw new Error('Model returned no response');
                stage = 'history-save';
                save();
                yield { type: 'result', text: reply.content };
                completed = true;
                break;
              }
              if (calls.length !== 1) throw new Error('Only one tool request per model step is supported');
              const call = calls[0];
              // Commit the uncertainty marker BEFORE invoking MCP. A restart never replays this call.
              history.interrupted = true;
              save();
              if (call.function.name !== 'area51__tool_action') throw new Error('Unknown model tool');
              const server = options.mcpServers?.area51;
              if (!server || server.type === 'http') throw new Error('Built-in stdio MCP server required');
              if (!client) {
                stage = 'mcp-connect';
                client = new Client({ name: 'area51-groq-mvp', version: '1.0.0' });
                const env = Object.fromEntries(
                  Object.entries(options.env ?? {}).filter(
                    (pair): pair is [string, string] =>
                      ['HOME', 'PATH', 'TZ'].includes(pair[0]) && pair[1] !== undefined,
                  ),
                );
                await client.connect(
                  new StdioClientTransport({
                    // Incus can start Bun with a minimal guest environment whose
                    // PATH omits /usr/local/bin. Reuse this runner's actual binary.
                    command: server.command === 'bun' ? process.execPath : server.command,
                    args: server.args,
                    env: { ...env, ...server.env },
                    cwd: server.cwd ?? input.cwd,
                  }),
                );
              }
              stage = 'mcp-call';
              const receipt = await client.callTool(
                { name: 'tool_action', arguments: JSON.parse(call.function.arguments) },
                undefined,
                { signal: controller.signal, timeout: 15000 },
              );
              stage = 'mcp-receipt';
              const requestId = JSON.stringify(receipt).match(/Tool request ([0-9a-f-]{36}) submitted\./)?.[1];
              if (!requestId || receipt.isError) throw new Error('Tool request was not accepted');
              let result: string | undefined;
              stage = 'host-result';
              const deadline = Date.now() + 120000;
              while (Date.now() < deadline && !controller.signal.aborted) {
                const row = getPendingMessages().find(
                  (message) => message.kind === 'system' && message.content.includes(`Tool request ${requestId}:`),
                );
                if (row) {
                  result = row.content;
                  markCompleted([row.id]);
                  break;
                }
                yield { type: 'activity' };
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
              if (!result) throw new Error('Tool outcome unknown: host reconciliation required; no retry');
              const notification = JSON.parse(result) as { text?: unknown };
              const prefix = `Tool request ${requestId}: `;
              if (
                typeof notification.text === 'string' &&
                notification.text.startsWith(prefix) &&
                /^(executed|denied|failed)\b/.test(notification.text.slice(prefix.length))
              )
                hostConfirmation = notification.text.slice(prefix.length);
              history.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
              history.interrupted = false;
              save();
            }
            if (!completed) throw new Error('Groq turn exceeded model call budget');
          }
        } catch (_error) {
          if (!controller.signal.aborted)
            yield {
              type: 'error',
              message: `Groq turn stopped safely at ${stage}. Inspect host diagnostics; uncertain actions are never retried.`,
              retryable: false,
            };
        } finally {
          await client?.close();
        }
      },
    };
    return {
      events,
      push(message) {
        if (!ended && !controller.signal.aborted) {
          queue.push(message);
          wake?.();
        }
      },
      end() {
        ended = true;
        wake?.();
      },
      abort() {
        controller.abort();
        wake?.();
      },
    };
  }
}

registerProvider('groq', (options) => new GroqProvider(options));
