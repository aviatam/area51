import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(),
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
}));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/area51-test-self-mod-apply' };
});

import {
  closeDb,
  createAgentGroup,
  createSession,
  ensureContainerConfig,
  getContainerConfig,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { applyAddMcpServer, applyInstallPackages } from './apply.js';

const TEST_DIR = '/tmp/area51-test-self-mod-apply';
const session: Session = {
  id: 'session-1',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildAgentGroupImage).mockResolvedValue(undefined);
  vi.mocked(killContainer).mockImplementation(() => {});
  vi.mocked(wakeContainer).mockResolvedValue(true);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  ensureContainerConfig('ag-1');
  createSession(session);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('applyAddMcpServer', () => {
  it('persists approved HTTPS MCP config', async () => {
    await applyAddMcpServer({ name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' }, session);

    expect(JSON.parse(getContainerConfig('ag-1')!.mcp_servers)).toEqual({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });
  });

  it('refuses to overwrite a plugin-owned server even after approval', async () => {
    updateContainerConfigJson('ag-1', 'mcp_servers', {
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });

    await applyAddMcpServer({ name: 'docs', type: 'http', url: 'https://evil.example.com/mcp' }, session);

    expect(JSON.parse(getContainerConfig('ag-1')!.mcp_servers)).toEqual({
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });
  });
});

describe('applyInstallPackages', () => {
  it('stops the old runtime before rebuilding and wakes only after the rebuild', async () => {
    const order: string[] = [];
    vi.mocked(killContainer).mockImplementation(() => {
      order.push('stop');
    });
    vi.mocked(buildAgentGroupImage).mockImplementation(async () => {
      order.push('build');
    });
    vi.mocked(wakeContainer).mockImplementation(async () => {
      order.push('wake');
      return true;
    });

    await applyInstallPackages({ npm: ['third-party-tool'] }, session);

    expect(order).toEqual(['stop', 'build', 'wake']);
    expect(killContainer).toHaveBeenCalledWith(session.id, 'runtime policy reevaluation');
    expect(JSON.parse(getContainerConfig('ag-1')!.packages_npm)).toEqual(['third-party-tool']);
  });

  it('keeps the runtime stopped when the rebuild fails', async () => {
    vi.mocked(buildAgentGroupImage).mockRejectedValueOnce(new Error('build failed'));

    await applyInstallPackages({ apt: ['git'] }, session);

    expect(killContainer).toHaveBeenCalledWith(session.id, 'runtime policy reevaluation');
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
