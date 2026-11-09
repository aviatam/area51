/**
 * Container runtime abstraction for Area51.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execFileSync(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', name], { stdio: 'pipe', timeout: 10_000 });
}

/** Bounded escalation followed by a separate daemon state read. Unknown state is failure. */
export function containContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error(`Invalid container name: ${name}`);
  try {
    stopContainer(name);
  } catch (error) {
    log.warn('Graceful containment stop failed', { name, error });
  }
  const stopped = (): boolean => {
    let output: string;
    try {
      output = execFileSync(CONTAINER_RUNTIME_BIN, ['inspect', '--format', '{{.State.Running}}', name], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: 'pipe',
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
      if (/No such (object|container):/.test(stderr)) return true;
      throw error;
    }
    return output.trim() === 'false';
  };
  try {
    if (stopped()) return;
  } catch (error) {
    log.warn('Containment state unavailable; attempting kill', { name, error });
  }
  execFileSync(CONTAINER_RUNTIME_BIN, ['kill', name], { timeout: 10_000, stdio: 'pipe' });
  if (!stopped()) throw new Error(`Container containment not verified: ${name}`);
}

/** Retry a held target independently of its exec client, without touching a replacement. */
export function reconcileContainment(options: {
  current: () => boolean;
  attempt: () => void;
  success: () => void;
  error: (error: unknown) => void;
  intervalMs?: number;
}): void {
  const reconcile = (): void => {
    if (!options.current()) return;
    try {
      options.attempt();
    } catch (error) {
      options.error(error);
      const retry = setTimeout(reconcile, options.intervalMs ?? 10_000);
      retry.unref();
      return;
    }
    options.success();
  };
  reconcile();
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart Area51                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned Area51 containers from THIS install's previous runs.
 *
 * Scoped by label `area51-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.Names}}'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        containContainer(name);
      } catch (error) {
        throw new Error(`Orphan containment not verified: ${name}`, { cause: error });
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.error('Failed to clean up orphaned containers', { err });
    throw err;
  }
}
