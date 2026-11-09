import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  containContainer,
  reconcileContainment,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('area51-test-123');
    expect(mockExecFileSync).toHaveBeenCalledWith(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', 'area51-test-123'], {
      stdio: 'pipe',
      timeout: 10_000,
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecFileSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.Names}}'],
      expect.any(Object),
    );
  });

  it('stops and verifies each orphan', () => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation((_bin, argv) =>
      argv[0] === 'ps' ? 'agent-1\nagent-2\n' : argv[0] === 'inspect' ? 'false' : '',
    );
    cleanupOrphans();
    expect(mockExecFileSync.mock.calls.map((call) => call[1][0])).toEqual(['ps', 'stop', 'inspect', 'stop', 'inspect']);
  });

  it('does nothing when no orphans exist', () => {
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('fails startup when runtime state cannot be reconciled', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    expect(() => cleanupOrphans()).toThrow('docker not available');

    expect(log.error).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('fails startup when orphan containment remains unknown', () => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValueOnce('agent-1\n').mockImplementation(() => {
      throw new Error('daemon unavailable');
    });
    expect(() => cleanupOrphans()).toThrow('Orphan containment not verified');
  });
});

describe('verified containment', () => {
  it('escalates a successful stop acknowledgement when daemon still reports running', () => {
    mockExecFileSync.mockReset();
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('true')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('false');
    containContainer('agent');
    expect(mockExecFileSync.mock.calls.map((call) => call[1][0])).toEqual(['stop', 'inspect', 'kill', 'inspect']);
  });
  it('fails when kill acknowledgement leaves execution running', () => {
    mockExecFileSync.mockReset();
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('true')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('true');
    expect(() => containContainer('agent')).toThrow('not verified');
  });
  it('still attempts kill if the first state read fails', () => {
    mockExecFileSync.mockReset();
    mockExecFileSync
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw new Error('transient read failure');
      })
      .mockReturnValueOnce('')
      .mockReturnValueOnce('false');
    containContainer('agent');
    expect(mockExecFileSync.mock.calls.map((call) => call[1][0])).toEqual(['stop', 'inspect', 'kill', 'inspect']);
  });
  it('does not interpret daemon failure as stopped', () => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValueOnce('').mockImplementation(() => {
      throw new Error('daemon unavailable');
    });
    expect(() => containContainer('agent')).toThrow('daemon unavailable');
  });
});

describe('held target reconciliation', () => {
  it('keeps retrying failed enforcement and completes only after verified success', () => {
    vi.useFakeTimers();
    try {
      const attempt = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('daemon down');
        })
        .mockImplementationOnce(() => {
          throw new Error('still running');
        })
        .mockImplementationOnce(() => {});
      const success = vi.fn();
      const error = vi.fn();
      reconcileContainment({ current: () => true, attempt, success, error });
      expect(success).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(success).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(success).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      expect(attempt).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not act on a replacement target when a retry fires', () => {
    vi.useFakeTimers();
    try {
      let current = true;
      const attempt = vi.fn(() => {
        throw new Error('stop failed');
      });
      const success = vi.fn();
      reconcileContainment({ current: () => current, attempt, success, error: vi.fn() });
      current = false;
      vi.advanceTimersByTime(10_000);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(success).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
