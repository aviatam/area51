import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileContainment } from './container-runtime.js';
import { assertNoDependencyHold, monitorDependencies, writeDependencyHold } from './dependency-monitor.js';
import type { DependencySecurityResult } from './dependency-security.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const unsafe: DependencySecurityResult = {
  findings: [],
  evidenceFiles: [],
  summary: {
    status: 'incomplete',
    scanner: 'synthetic outage control',
    checked_at: '2026-11-09',
    files: [],
    packages: [],
    limitations: ['No real daemon or advisory service used'],
  },
};

describe('dependency detection through containment reconciliation', () => {
  it('persists a hold before failed enforcement and keeps retrying until verified success', async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-containment-integration-'));
    roots.push(root);
    const error = vi.fn();
    const attempt = vi.fn(() => {
      expect(() => assertNoDependencyHold(root, 'qa-session')).toThrow('Session held');
      if (attempt.mock.calls.length < 3) throw new Error('synthetic daemon unavailable');
    });
    const success = vi.fn();
    let pending = false;
    const stop = monitorDependencies({
      groupDir: root,
      current: () => true,
      intervalMs: 10,
      scan: async () => unsafe,
      error,
      unsafe: (result) => {
        if (pending) return;
        pending = true;
        writeDependencyHold(root, 'qa-session', result, { backend: 'docker', name: 'area51-qa-session' });
        reconcileContainment({
          current: () => true,
          attempt,
          intervalMs: 20,
          error,
          success: () => {
            success();
            stop();
          },
        });
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(success).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(() => assertNoDependencyHold(root, 'qa-session')).toThrow('Session held');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stale retry after the runtime identity is replaced', async () => {
    vi.useFakeTimers();
    let current = true;
    const attempt = vi.fn(() => {
      throw new Error('synthetic first failure');
    });
    const success = vi.fn();
    reconcileContainment({ current: () => current, attempt, success, error: vi.fn(), intervalMs: 10 });
    current = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
