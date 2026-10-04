import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Session } from '../../types.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { stopHostModules } from '../../host-lifecycle.js';
import { writeSessionMessage } from '../../session-manager.js';
import { grantRole, revokeRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import './index.js';

const state = vi.hoisted(() => ({ execute: vi.fn(), revision: 'v1' }));
vi.mock('../../tool-action-config.js', () => ({
  loadToolConfiguration: () => ({
    revision: state.revision,
    actions: { send: { execute: state.execute }, read: { execute: state.execute } },
    policy: { 'ag-1': { send: 'approval', read: 'allow' }, 'ag-2': { send: 'deny' } },
    approvalTtlMs: 60_000,
  }),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../session-manager.js', async () => ({
  ...(await vi.importActual('../../session-manager.js')),
  writeSessionMessage: vi.fn(),
}));

let session: Session;
const stamp = () => new Date().toISOString();
beforeEach(() => {
  vi.clearAllMocks();
  state.execute.mockResolvedValue({ httpStatus: 200 });
  state.revision = 'v1';
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['ag-1', 'ag-2'])
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: stamp() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: stamp(),
    created_at: stamp(),
  };
  createSession(session);
  upsertUser({ id: 'slack:admin', kind: 'slack', display_name: 'Admin', created_at: stamp() });
  grantRole({ user_id: 'slack:admin', role: 'owner', agent_group_id: null, granted_by: null, granted_at: stamp() });
  createMessagingGroup({
    id: 'dm',
    channel_type: 'slack',
    platform_id: 'D-admin',
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: stamp(),
  });
  upsertUserDm({ user_id: 'slack:admin', channel_type: 'slack', messaging_group_id: 'dm', resolved_at: stamp() });
  setDeliveryAdapter({ deliver: vi.fn().mockResolvedValue('platform-msg') });
});
afterEach(async () => {
  await stopHostModules();
  closeDb();
});

const request = (id = 'req-1', tool = 'send') =>
  getDeliveryAction('tool_action')!(
    { action: 'tool_action', tool, args: { text: 'reviewed' }, requestId: id },
    session,
    null as never,
  );
function click(id: string, userId = 'slack:admin', value = 'approve') {
  return handleApprovalsResponse({
    questionId: id,
    value,
    userId,
    channelType: 'slack',
    platformId: 'D-admin',
    threadId: null,
  });
}

it('connects actual delivery and authorized approval registries with one execution', async () => {
  await request();
  const row = getPendingApprovalsByAction('tool_action')[0];
  expect(row.question).toContain('{"tool":"send","args":{"text":"reviewed"}}\nExpires at ');
  expect(row.expires_at).toBeTruthy();
  expect(state.execute).not.toHaveBeenCalled();
  await click(row.approval_id, 'slack:guest');
  expect(state.execute).not.toHaveBeenCalled();
  await Promise.all([click(row.approval_id), click(row.approval_id)]);
  await click(row.approval_id);
  expect(state.execute).toHaveBeenCalledExactlyOnceWith({ text: 'reviewed' });
  expect(getPendingApprovalsByAction('tool_action')).toHaveLength(0);
});

it.each(['role', 'config', 'shutdown', 'reject', 'session-end'])(
  'blocks a production approval after %s',
  async (change) => {
    await request();
    const row = getPendingApprovalsByAction('tool_action')[0];
    if (change === 'role') revokeRole('slack:admin', 'owner', null);
    if (change === 'config') state.revision = 'v2';
    if (change === 'shutdown') await stopHostModules();
    if (change === 'session-end') {
      const { getDb } = await import('../../db/connection.js');
      getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(session.id);
    }
    await click(row.approval_id, 'slack:admin', change === 'reject' ? 'reject' : 'approve');
    expect(state.execute).not.toHaveBeenCalled();
  },
);

it('reserves allowed operations durably and blocks redelivery after shutdown', async () => {
  await request('read-1', 'read');
  await stopHostModules();
  await request('read-1', 'read');
  expect(state.execute).toHaveBeenCalledTimes(1);
});

it('removes a failed delivery continuation and keeps upstream errors out of the inbox', async () => {
  setDeliveryAdapter({ deliver: vi.fn().mockRejectedValue(new Error('platform-private-secret')) });
  await request();
  expect(getPendingApprovalsByAction('tool_action')).toHaveLength(0);
  expect(state.execute).not.toHaveBeenCalled();
  state.execute.mockRejectedValue(new Error('upstream-private-secret'));
  await request('read-1', 'read');
  await request('read-1', 'read');
  expect(state.execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(vi.mocked(writeSessionMessage).mock.calls)).not.toContain('upstream-private-secret');
});

it('caps durable reservations and preserves them through repeat migrations', async () => {
  const { getDb } = await import('../../db/connection.js');
  const db = getDb();
  const insert = db.prepare('INSERT INTO tool_action_requests VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) insert.run(session.id, `reserved-${i}`, stamp());
  })();
  runMigrations(db);
  await request('over-limit', 'read');
  expect(state.execute).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) AS count FROM tool_action_requests').get()).toEqual({ count: 1000 });
});
