import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type { ToolAction, ToolPermission } from './tool-action-broker.js';

export interface ToolConfiguration {
  revision: string;
  policy: Record<string, Record<string, ToolPermission>>;
  actions: Record<string, ToolAction>;
  approvalTtlMs: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool configuration');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, permitted: string[]): void {
  if (Object.keys(value).some((key) => !permitted.includes(key))) throw new Error('Unknown configuration field');
}

/** Fixed host-owned destinations, methods, credentials and argument fields. Upstream
 * bodies are never returned to the agent or logged. No redirects or retries. */
export function parseToolConfiguration(raw: string, send: typeof fetch = fetch): ToolConfiguration {
  if (Buffer.byteLength(raw) > 65_536) throw new Error('Tool configuration too large');
  const config = object(JSON.parse(raw));
  keys(config, ['schema', 'actions', 'policy', 'approvalTtlMs']);
  if (config.schema !== 'area51.tool-actions.v1') throw new Error('Unsupported tool configuration');
  const ttl = config.approvalTtlMs ?? 60_000;
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 300_000)
    throw new Error('Approval TTL must be 1000..300000 milliseconds');
  const actions: Record<string, ToolAction> = Object.create(null);
  for (const [name, value] of Object.entries(object(config.actions))) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) throw new Error('Invalid action name');
    const spec = object(value);
    keys(spec, ['url', 'method', 'token', 'arguments', 'required']);
    const method = spec.method ?? 'POST';
    if (method !== 'POST' && method !== 'GET') throw new Error('Only fixed GET or POST actions supported');
    if (typeof spec.url !== 'string' || typeof spec.token !== 'string' || !spec.token || /[\r\n]/.test(spec.token))
      throw new Error('Fixed URL and credential required');
    const url = new URL(spec.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error('HTTPS destination without URL credentials, query or fragment required');
    const fields = object(spec.arguments);
    if (method === 'GET' && Object.keys(fields).length) throw new Error('GET actions accept no guest arguments');
    if (
      Object.entries(fields).some(
        ([key, type]) =>
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || !['string', 'number', 'boolean'].includes(String(type)),
      )
    )
      throw new Error('Invalid argument schema');
    const required = spec.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string' || !Object.hasOwn(fields, key)))
      throw new Error('Invalid required fields');
    const token = spec.token;
    const validate: NonNullable<ToolAction['validate']> = (args) =>
      !(
        required.some((key) => !Object.hasOwn(args, key)) ||
        Object.entries(args).some(
          ([key, value]) =>
            !Object.hasOwn(fields, key) ||
            typeof value !== fields[key] ||
            // Approval previews must not contain invisible controls or bidi overrides.
            (typeof value === 'string' &&
              // eslint-disable-next-line no-control-regex
              (value.length > 2048 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069`]/.test(value))) ||
            (typeof value === 'number' && !Number.isFinite(value)),
        )
      );
    actions[name] = {
      validate,
      async execute(args) {
        if (!validate(args)) throw new Error('Invalid action arguments');
        const response = await send(url, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: method === 'POST' ? JSON.stringify(args) : undefined,
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Upstream action failed');
        return { httpStatus: response.status };
      },
    };
  }
  const policy: ToolConfiguration['policy'] = Object.create(null);
  for (const [group, value] of Object.entries(object(config.policy))) {
    if (!group || group.length > 128) throw new Error('Invalid group identity');
    const rules = object(value);
    if (
      Object.entries(rules).some(
        ([action, permission]) =>
          !Object.hasOwn(actions, action) || !['allow', 'deny', 'approval'].includes(String(permission)),
      )
    )
      throw new Error('Invalid tool permission');
    policy[group] = rules as Record<string, ToolPermission>;
  }
  return { revision: createHash('sha256').update(raw).digest('hex'), actions, policy, approvalTtlMs: ttl };
}

/** Linux GA configuration is private, owned by the host service user and
 * outside mounted workspaces. Missing configuration leaves the module disabled. */
export function loadToolConfiguration(file: string): ToolConfiguration | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Cannot open private tool configuration', { cause: error });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65_536 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Tool configuration must be a private host-owned regular file');
    try {
      return parseToolConfiguration(fs.readFileSync(fd, 'utf8'));
    } catch {
      // JSON parser errors can quote credential-bearing input. Redact them.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Invalid private tool configuration');
    }
  } finally {
    fs.closeSync(fd);
  }
}
