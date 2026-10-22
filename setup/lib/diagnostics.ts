import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const INSTALL_ID_PATH = path.join('data', 'install-id');

let cached: string | null = null;

/**
 * `persist: false` reads an existing id but never creates `data/install-id`
 * — required by the uninstall path, which must not mutate the filesystem
 * before (or instead of) removing it. Events in one process still join:
 * the generated id is cached.
 */
export function installId(persist = true): string {
  if (cached) return cached;
  try {
    const existing = fs.readFileSync(INSTALL_ID_PATH, 'utf-8').trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    // fall through to create
  }
  const id = randomUUID().toLowerCase();
  if (persist) {
    try {
      fs.mkdirSync(path.dirname(INSTALL_ID_PATH), { recursive: true });
      fs.writeFileSync(INSTALL_ID_PATH, id);
    } catch {
      // best-effort; still return the id so the event fires
    }
  }
  cached = id;
  return id;
}

/** Compatibility hook: Area51 sends no inherited setup telemetry. */
export function emit(
  _event: string,
  _props: Record<string, string | number | boolean | undefined> = {},
  _opts: { persistId?: boolean } = {},
): void {
  // Local setup logs are the diagnostic record. No network request or install ID creation.
}
