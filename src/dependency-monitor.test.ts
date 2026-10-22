import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertNoDependencyHold,
  dependencyHoldPath,
  monitorDependencies,
  writeDependencyHold,
} from './dependency-monitor.js';
import type { DependencySecurityResult } from './dependency-security.js';

const clean: DependencySecurityResult = {
  findings: [],
  evidenceFiles: [],
  summary: {
    status: 'complete',
    scanner: 'test',
    checked_at: '2026-10-22T00:00:00Z',
    files: [],
    packages: [],
    limitations: [],
  },
};
afterEach(() => {
  vi.useRealTimers();
});

it('polls required coverage without overlapping slow scans and contains incomplete results automatically', async () => {
  vi.useFakeTimers();
  let resolve!: (value: DependencySecurityResult) => void;
  const scan = vi.fn(
    () =>
      new Promise<DependencySecurityResult>((r) => {
        resolve = r;
      }),
  );
  const unsafe = vi.fn(),
    error = vi.fn();
  const stop = monitorDependencies({ groupDir: '/group', current: () => true, scan, unsafe, error });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(scan).toHaveBeenCalledWith('/group', { required: true, preserveEvidence: true });
  resolve({ ...clean, summary: { ...clean.summary, status: 'incomplete' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(unsafe).toHaveBeenCalledTimes(1);
  stop();
});

it('refreshes unchanged inventories so newly published advisories trigger containment', async () => {
  vi.useFakeTimers();
  const risky = {
    ...clean,
    findings: [
      {
        id: 'dependency-advisory-test',
        severity: 'high' as const,
        pillar: 'security' as const,
        title: 'Advisory',
        detail: 'New advisory',
        evidence: [],
        recommendation: 'Review',
      },
    ],
  };
  const scan = vi.fn().mockResolvedValueOnce(clean).mockResolvedValueOnce(risky);
  const unsafe = vi.fn();
  const stop = monitorDependencies({ groupDir: '/group', current: () => true, scan, unsafe, error: vi.fn() });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(unsafe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(unsafe).toHaveBeenCalledWith(risky);
  stop();
});

it('fails closed on unexpected scanner exceptions', async () => {
  vi.useFakeTimers();
  const unsafe = vi.fn();
  const stop = monitorDependencies({
    groupDir: '/group',
    current: () => true,
    scan: vi.fn().mockRejectedValue(new Error('disk full')),
    unsafe,
    error: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(unsafe.mock.calls[0][0].summary.status).toBe('incomplete');
  stop();
});

it('does not apply stale results to a replacement or stopped runtime', async () => {
  vi.useFakeTimers();
  let resolve!: (value: DependencySecurityResult) => void;
  const scan = vi.fn(
    () =>
      new Promise<DependencySecurityResult>((r) => {
        resolve = r;
      }),
  );
  const unsafe = vi.fn();
  const stop = monitorDependencies({ groupDir: '/group', current: () => true, scan, unsafe, error: vi.fn() });
  await vi.advanceTimersByTimeAsync(60_000);
  stop();
  resolve({ ...clean, summary: { ...clean.summary, status: 'incomplete' } });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(unsafe).not.toHaveBeenCalled();
  expect(scan).toHaveBeenCalledTimes(1);
});

it('persists holds outside session mounts and blocks restart without overwriting evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-hold-test-'));
  try {
    assertNoDependencyHold(root, '../session');
    const destination = writeDependencyHold(root, '../session', clean);
    expect(destination).toBe(dependencyHoldPath(root, '../session'));
    expect(path.dirname(destination)).toBe(path.join(root, 'dependency-holds'));
    expect(() => assertNoDependencyHold(root, '../session')).toThrow('held');
    expect(() => writeDependencyHold(root, '../session', clean)).toThrow();
    expect(JSON.parse(fs.readFileSync(destination, 'utf8')).session_id).toBe('../session');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
