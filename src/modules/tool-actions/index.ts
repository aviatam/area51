import os from 'node:os';
import path from 'node:path';

import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { SessionToolActions } from '../../session-tool-actions.js';
import { loadToolConfiguration } from '../../tool-action-config.js';
import {
  notifyAgent,
  pickApprover,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
} from '../approvals/primitive.js';

registerMigration({
  name: 'module:tool-actions:request-reservations',
  version: 1,
  up(db) {
    db.exec(`CREATE TABLE tool_action_requests (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, request_id)
    )`);
  },
});

const configurationFile = path.join(os.homedir(), '.config', 'area51', 'tool-actions.json');
const tools = new SessionToolActions({
  configuration: () => loadToolConfiguration(configurationFile),
  approvers: pickApprover,
  active: (session) => {
    const fresh = getSession(session.id);
    return fresh?.status === 'active' && fresh.agent_group_id === session.agent_group_id;
  },
  reserve: (session, requestId) =>
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO tool_action_requests (session_id, request_id, created_at)
        SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM tool_action_requests WHERE session_id = ?) < 1000
        AND (SELECT COUNT(*) FROM tool_action_requests) < 50000`,
      )
      .run(session.id, requestId, new Date().toISOString(), session.id).changes === 1,
  approval: async (session, id, preview, expiresAt) => {
    const fullSession = getSession(session.id);
    if (!fullSession || !getDeliveryAdapter()) return false;
    return requestApproval({
      session: fullSession,
      agentName: session.agent_group_id,
      action: 'tool_action',
      payload: { brokerApprovalId: id },
      title: `Approve tool action: ${session.agent_group_id}`,
      question: `\`\`\`json\n${preview}\n\`\`\`\nExpires at ${new Date(expiresAt).toISOString()}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  },
  audit: (event) => log.info('Tool action', event),
});

registerDeliveryAction(
  'tool_action',
  async (content, session) => {
    try {
      const result = await tools.request(session, content);
      notifyAgent(session, `Tool action ${result.status}.`);
    } catch {
      // No raw config, credential, upstream or audit-sink errors enter the inbox.
      notifyAgent(session, 'Tool action failed; no automatic retry.');
    }
  },
  unguarded('SessionToolActions consults the default-deny broker and durably reserves requests before dispatch.'),
);

registerApprovalHandler('tool_action', async ({ session, payload, userId, notify }) => {
  try {
    const result =
      typeof payload.brokerApprovalId === 'string'
        ? await tools.resolve(session, payload.brokerApprovalId, userId, true)
        : { status: 'denied' };
    notify(`Tool action ${result.status}.`);
  } catch {
    notify('Tool action failed; no automatic retry.');
  }
});
registerApprovalResolvedHandler(({ approval }) => {
  if (approval.action !== 'tool_action') return;
  const payload = JSON.parse(approval.payload) as Record<string, unknown>;
  if (typeof payload.brokerApprovalId === 'string') tools.cancel(payload.brokerApprovalId);
});
onHostShutdown(() => tools.cancel());
onHostStart(() => {
  log.info('Host tool actions configuration', { enabled: loadToolConfiguration(configurationFile) !== null });
});
