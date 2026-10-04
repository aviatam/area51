import { randomUUID } from 'node:crypto';

export type ToolArguments = Record<string, unknown>;
export type ToolPermission = 'allow' | 'deny' | 'approval';
export interface ToolAction {
  validate?: (args: ToolArguments) => boolean;
  execute: (args: ToolArguments) => Promise<unknown>;
}
export type ToolResult =
  | { status: 'denied' | 'expired' | 'failed' }
  | { status: 'pending'; approvalId: string }
  | { status: 'executed'; value: unknown };
export interface ToolAuditEvent {
  agentId: string;
  action: string;
  status: ToolResult['status'] | 'rejected' | 'dispatching';
  approvalId?: string;
  approverId?: string;
}

interface PendingAction {
  agentId: string;
  action: string;
  args: ToolArguments;
  expiresAt: number;
}

/** Host-side reference broker. Identity, policy, handlers and approvers must
 * come from trusted host configuration, never from guest request fields.
 * Only calls dispatched through this broker are governed by it. */
export class ToolActionBroker {
  private readonly pending = new Map<string, PendingAction>();
  private readonly policy: Map<string, Map<string, ToolPermission>>;
  private readonly actions: Map<string, ToolAction>;
  private readonly approvers: Set<string>;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly limit: number;
  private readonly audit: (event: ToolAuditEvent) => void;

  constructor(options: {
    policy: Record<string, Record<string, ToolPermission>>;
    actions: Record<string, ToolAction>;
    approvers: string[];
    approvalTtlMs?: number;
    maxPending?: number;
    now?: () => number;
    audit?: (event: ToolAuditEvent) => void;
  }) {
    this.policy = new Map(
      Object.entries(options.policy).map(([agent, rules]) => [agent, new Map(Object.entries(rules))]),
    );
    this.actions = new Map(
      Object.entries(options.actions).map(([name, handler]) => [
        name,
        { execute: handler.execute, validate: handler.validate },
      ]),
    );
    this.approvers = new Set(options.approvers);
    this.now = options.now ?? Date.now;
    this.ttl = options.approvalTtlMs ?? 60_000;
    this.limit = options.maxPending ?? 100;
    this.audit = options.audit ?? (() => {});
    if (!Number.isSafeInteger(this.ttl) || this.ttl <= 0 || !Number.isSafeInteger(this.limit) || this.limit <= 0)
      throw new Error('Positive finite approval TTL and pending limit required');
  }

  /** Bind a transport to a host-authenticated identity. Do not expose this
   * factory itself to the guest, or accept a guest-supplied agentId. */
  bindAgent(agentId: string): (action: string, args: ToolArguments) => Promise<ToolResult> {
    return async (action, args) => {
      const permission = this.policy.get(agentId)?.get(action);
      const handler = this.actions.get(action);
      if (!handler || (permission !== 'allow' && permission !== 'approval'))
        return this.finish(agentId, action, { status: 'denied' });
      let snapshot: ToolArguments;
      try {
        // Wire semantics: JSON data only. Serialize synchronously so a caller
        // cannot mutate approved arguments while waiting for a decision.
        const serialized = JSON.stringify(args);
        if (!serialized || Buffer.byteLength(serialized) > 65_536) throw new Error('Invalid arguments');
        snapshot = JSON.parse(serialized) as ToolArguments;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Object required');
        if (handler.validate && !handler.validate(snapshot)) throw new Error('Invalid action arguments');
      } catch {
        return this.finish(agentId, action, { status: 'denied' });
      }
      if (permission === 'allow') return this.execute({ agentId, action, args: snapshot, expiresAt: 0 });
      this.pruneExpired();
      if (this.pending.size >= this.limit) return this.finish(agentId, action, { status: 'denied' });
      const approvalId = randomUUID();
      const item = { agentId, action, args: snapshot, expiresAt: this.now() + this.ttl };
      this.emit({ agentId, action, status: 'pending', approvalId });
      this.pending.set(approvalId, item);
      return { status: 'pending', approvalId };
    };
  }

  /** Host-authenticated approver only. No replacement arguments or action are
   * accepted. Consume before awaiting the handler to prevent duplicate sends. */
  async resolve(approvalId: string, approverId: string, approve: boolean): Promise<ToolResult> {
    const item = this.pending.get(approvalId);
    if (!item || !this.approvers.has(approverId)) return { status: 'denied' };
    this.pending.delete(approvalId);
    if (this.now() >= item.expiresAt)
      return this.finish(item.agentId, item.action, { status: 'expired' }, approvalId, approverId);
    if (!approve) return this.finish(item.agentId, item.action, { status: 'denied' }, approvalId, approverId);
    return this.execute(item, approvalId, approverId);
  }

  inspectApproval(approvalId: string, approverId: string): PendingAction | undefined {
    if (!this.approvers.has(approverId)) return undefined;
    const item = this.pending.get(approvalId);
    if (!item || this.now() >= item.expiresAt) return undefined;
    return structuredClone(item);
  }

  /** Process restart discards all pending approvals; shutdown also denies them. */
  cancelPending(): void {
    const items = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, item] of items)
      this.emit({ agentId: item.agentId, action: item.action, status: 'rejected', approvalId: id });
  }

  private pruneExpired(): void {
    for (const [id, item] of this.pending) {
      if (this.now() >= item.expiresAt) {
        this.pending.delete(id);
        this.emit({ agentId: item.agentId, action: item.action, status: 'expired', approvalId: id });
      }
    }
  }

  private emit(event: ToolAuditEvent): void {
    // Throwing audit sinks fail closed before dispatch. No args or credentials
    // are included in events. Applications own redaction of handler responses.
    this.audit(event);
  }

  private finish(
    agentId: string,
    action: string,
    result: ToolResult,
    approvalId?: string,
    approverId?: string,
  ): ToolResult {
    this.emit({ agentId, action, status: result.status, approvalId, approverId });
    return result;
  }

  private async execute(item: PendingAction, approvalId?: string, approverId?: string): Promise<ToolResult> {
    this.emit({ agentId: item.agentId, action: item.action, status: 'dispatching', approvalId, approverId });
    try {
      const value = await this.actions.get(item.action)!.execute(item.args);
      return this.finish(item.agentId, item.action, { status: 'executed', value }, approvalId, approverId);
    } catch {
      // Do not retry an ambiguous external side effect or expose handler errors.
      return this.finish(item.agentId, item.action, { status: 'failed' }, approvalId, approverId);
    }
  }
}
