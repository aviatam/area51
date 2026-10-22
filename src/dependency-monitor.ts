import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanDependencySecurity, type DependencySecurityResult } from './dependency-security.js';

export function dependencyHoldPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'dependency-holds', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

export function assertNoDependencyHold(dataDir: string, sessionId: string): void {
  if (fs.existsSync(dependencyHoldPath(dataDir, sessionId)))
    throw new Error(
      'Session held by dependency security. Preserve evidence and review before an operator releases it.',
    );
}

/** Persist before containment, so restart/sweep cannot silently resume a held workload. */
export function writeDependencyHold(dataDir: string, sessionId: string, result: DependencySecurityResult): string {
  const destination = dependencyHoldPath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    destination,
    JSON.stringify({ session_id: sessionId, held_at: new Date().toISOString(), ...result }, null, 2) + '\n',
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  return destination;
}

/** Bounded polling with no overlapping scans. Cancellation suppresses stale scan results. */
export function monitorDependencies(options: {
  groupDir: string;
  current: () => boolean;
  unsafe: (result: DependencySecurityResult) => void | Promise<void>;
  error: (error: unknown) => void;
  scan?: typeof scanDependencySecurity;
  intervalMs?: number;
}): () => void {
  let stopped = false,
    busy = false;
  const timer = setInterval(() => {
    if (stopped || busy || !options.current()) return;
    busy = true;
    void (async () => {
      let result: DependencySecurityResult;
      try {
        result = await (options.scan ?? scanDependencySecurity)(options.groupDir, {
          required: true,
          preserveEvidence: true,
        });
      } catch (error) {
        options.error(error);
        result = {
          findings: [],
          evidenceFiles: [],
          summary: {
            status: 'incomplete',
            scanner: 'unavailable',
            checked_at: new Date().toISOString(),
            files: [],
            packages: [],
            limitations: ['Unexpected scanner failure; coverage is unknown.'],
          },
        };
      }
      if (!stopped && options.current() && (result.summary.status !== 'complete' || result.findings.length))
        await options.unsafe(result);
    })()
      .catch(options.error)
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs ?? 60_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
