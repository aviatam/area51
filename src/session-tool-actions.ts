import { ToolActionBroker, type ToolResult } from './tool-action-broker.js';
import type { ToolConfiguration } from './tool-action-config.js';

export interface ToolSession {
  id: string;
  agent_group_id: string;
}
interface Pending {
  session: ToolSession;
  broker: ToolActionBroker;
  revision: string;
  expiresAt: number;
}

/** The session comes from the host poller; request fields cannot choose it.
 * Durable reservation precedes any dispatch. Crashed/ambiguous operations are
 * never automatically retried; pending approvals do not survive restart. */
export class SessionToolActions {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly ports: {
      configuration: () => ToolConfiguration | null;
      approvers: (group: string) => string[];
      reserve: (session: ToolSession, requestId: string) => boolean;
      active?: (session: ToolSession) => boolean;
      approval: (
        session: ToolSession,
        id: string,
        preview: string,
        expiresAt: number,
        requestId: string,
      ) => Promise<boolean>;
      audit?: (event: {
        sessionId: string;
        requestId: string;
        approvalId?: string;
        action: string;
        status: string;
      }) => void;
      now?: () => number;
    },
  ) {}

  async request(session: ToolSession, content: Record<string, unknown>): Promise<ToolResult> {
    if (this.ports.active && !this.ports.active(session)) return { status: 'denied' };
    if (
      Object.keys(content).sort().join(',') !== 'action,args,requestId,tool' ||
      content.action !== 'tool_action' ||
      typeof content.requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(content.requestId) ||
      typeof content.tool !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(content.tool) ||
      !content.args ||
      typeof content.args !== 'object' ||
      Array.isArray(content.args)
    )
      return { status: 'denied' };
    if (!this.ports.reserve(session, content.requestId)) return { status: 'denied' };
    const config = this.ports.configuration();
    if (!config) return { status: 'denied' };
    this.prune();
    if (this.pending.size >= 100) return { status: 'denied' };
    const broker = new ToolActionBroker({
      policy: config.policy,
      actions: config.actions,
      approvers: this.ports.approvers(session.agent_group_id),
      approvalTtlMs: config.approvalTtlMs,
      maxPending: 1,
      now: this.ports.now,
      audit: (event) =>
        this.ports.audit?.({
          sessionId: session.id,
          requestId: content.requestId as string,
          approvalId: event.approvalId,
          action: event.action,
          status: event.status,
        }),
    });
    const result = await broker.bindAgent(session.agent_group_id)(
      content.tool,
      content.args as Record<string, unknown>,
    );
    if (result.status !== 'pending') return result;
    const admin = this.ports.approvers(session.agent_group_id)[0];
    const snapshot = admin && broker.inspectApproval(result.approvalId, admin);
    // Show the complete canonical request; never truncate an approval preview.
    const preview =
      snapshot && JSON.stringify({ agentGroupId: session.agent_group_id, tool: snapshot.action, args: snapshot.args });
    if (!preview || preview.length > 3000) {
      broker.cancelPending();
      return { status: 'denied' };
    }
    this.pending.set(result.approvalId, {
      session: { ...session },
      broker,
      revision: config.revision,
      expiresAt: this.now() + config.approvalTtlMs,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = this.pending.get(result.approvalId)!.expiresAt;
      const delivered = await Promise.race([
        this.ports.approval(session, result.approvalId, preview, deadline, content.requestId),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(1, deadline - this.now()));
        }),
      ]);
      if (delivered) return result;
    } catch {
      // Delivery failure must leave no executable continuation.
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.pending.delete(result.approvalId);
    broker.cancelPending();
    return { status: 'denied' };
  }

  async resolve(session: ToolSession, id: string, userId: string, approve: boolean): Promise<ToolResult> {
    const item = this.pending.get(id);
    if (
      !item ||
      item.session.id !== session.id ||
      item.session.agent_group_id !== session.agent_group_id ||
      !this.ports.approvers(session.agent_group_id).includes(userId)
    )
      return { status: 'denied' };
    // Consume synchronously, before any await, including concurrent clicks.
    this.pending.delete(id);
    if (this.ports.active && !this.ports.active(session)) {
      item.broker.cancelPending();
      return { status: 'denied' };
    }
    const config = this.ports.configuration();
    if (!config || config.revision !== item.revision) {
      item.broker.cancelPending();
      return { status: 'denied' };
    }
    return item.broker.resolve(id, userId, approve);
  }

  cancel(id?: string): void {
    for (const [key, item] of this.pending) {
      if (id === undefined || id === key) {
        this.pending.delete(key);
        item.broker.cancelPending();
      }
    }
  }
  private now(): number {
    return (this.ports.now ?? Date.now)();
  }
  private prune(): void {
    for (const [id, item] of this.pending) if (this.now() >= item.expiresAt) this.cancel(id);
  }
}
