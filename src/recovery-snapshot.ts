/** Offline host-state snapshots. Never overwrite or activate a live install. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Entry = { path: string; kind: 'directory' | 'file'; size: number; sha256: string; executable: boolean };
export interface SnapshotManifest {
  schema: 'area51.host-state.v1';
  commit: string;
  createdAt: string;
  offlineAcknowledged: true;
  scope: string[];
  entries: Entry[];
}
const scope = ['install/data', 'install/store', 'install/groups', 'install/.env', 'host-config'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function root(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root || fs.realpathSync(resolved) !== resolved)
    throw new Error('Explicit non-symlink directory required');
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Directory required');
  return resolved;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function newDestination(value: string, sources: string[]): string {
  const target = path.resolve(value);
  root(path.dirname(target));
  if (sources.some((source) => inside(source, target) || inside(target, source)))
    throw new Error('Source and destination must not overlap');
  fs.mkdirSync(target, { mode: 0o700 }); // EEXIST is deliberate, even for an empty directory.
  return target;
}

function fileHash(file: string): { size: number; sha256: string } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error('Regular unlinked file required');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
      size += n;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('State changed during capture');
    return { size, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

function inventory(base: string, relative: string, entries: Entry[]): void {
  const file = path.join(base, relative);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error('Symbolic links are not supported in snapshots');
  if (stat.isDirectory()) {
    entries.push({
      path: relative.split(path.sep).join('/'),
      kind: 'directory',
      size: 0,
      sha256: '',
      executable: false,
    });
    for (const name of fs.readdirSync(file).sort()) inventory(base, path.join(relative, name), entries);
  } else if (stat.isFile()) {
    entries.push({
      path: relative.split(path.sep).join('/'),
      kind: 'file',
      ...fileHash(file),
      executable: !!(stat.mode & 0o100),
    });
  } else {
    throw new Error('Sockets and other special files must be removed after stopping services');
  }
}

function current(install: string, config: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of ['data', 'store', 'groups', '.env']) {
    const source = path.join(install, name);
    if (!fs.existsSync(source) && !fs.lstatSync(source, { throwIfNoEntry: false })) continue;
    const next: Entry[] = [];
    inventory(install, name, next);
    entries.push(...next.map((entry) => ({ ...entry, path: `install/${entry.path}` })));
  }
  const next: Entry[] = [];
  // Inventory the config root itself, including an empty directory.
  for (const name of fs.readdirSync(config).sort()) inventory(config, name, next);
  entries.push({ path: 'host-config', kind: 'directory', size: 0, sha256: '', executable: false });
  entries.push(...next.map((entry) => ({ ...entry, path: `host-config/${entry.path}` })));
  if (!entries.some((entry) => entry.path === 'install/data/v2.db' && entry.kind === 'file'))
    throw new Error('Central database is required');
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function copy(entries: Entry[], sourceFor: (entry: Entry) => string, target: string): void {
  for (const entry of entries.filter((entry) => entry.kind === 'directory'))
    fs.mkdirSync(path.join(target, entry.path), { recursive: true, mode: 0o700 });
  for (const entry of entries.filter((entry) => entry.kind === 'file')) {
    const output = path.join(target, entry.path);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourceFor(entry), output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, entry.executable ? 0o700 : 0o600);
    const measured = fileHash(output);
    if (measured.size !== entry.size || measured.sha256 !== entry.sha256) throw new Error('Copy verification failed');
    const fd = fs.openSync(output, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function createSnapshot(options: {
  install: string;
  hostConfig: string;
  output: string;
  commit: string;
  offlineAcknowledged: boolean;
}): { manifest: SnapshotManifest; manifestSha256: string } {
  if (!options.offlineAcknowledged) throw new Error('Stop all host and guest writers and acknowledge offline state');
  if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error('Exact code commit required');
  const install = root(options.install);
  const config = root(options.hostConfig);
  if (inside(install, config) || inside(config, install)) throw new Error('Host configuration must be outside install');
  const entries = current(install, config);
  const output = newDestination(options.output, [install, config]);
  const payload = path.join(output, 'payload');
  fs.mkdirSync(payload, { mode: 0o700 });
  copy(
    entries,
    (entry) =>
      entry.path.startsWith('install/')
        ? path.join(install, entry.path.slice(8))
        : path.join(config, entry.path.slice(12)),
    payload,
  );
  if (JSON.stringify(current(install, config)) !== JSON.stringify(entries))
    throw new Error('State changed; snapshot incomplete');
  const manifest: SnapshotManifest = {
    schema: 'area51.host-state.v1',
    commit: options.commit,
    createdAt: new Date().toISOString(),
    offlineAcknowledged: true,
    scope,
    entries,
  };
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(output, 'manifest.json'), raw, { flag: 'wx', mode: 0o600 });
  const manifestSha256 = digest(raw);
  verifySnapshot(output, manifestSha256);
  fs.writeFileSync(path.join(output, 'COMPLETE'), manifestSha256 + '\n', { flag: 'wx', mode: 0o600 });
  return { manifest, manifestSha256 };
}

export function verifySnapshot(snapshot: string, expectedDigest: string): SnapshotManifest {
  const base = root(snapshot);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Independently retained manifest digest required');
  const manifestFile = path.join(base, 'manifest.json');
  if (!fs.lstatSync(manifestFile).isFile() || fs.statSync(manifestFile).size > 16 * 1024 * 1024)
    throw new Error('Invalid manifest file');
  const raw = fs.readFileSync(manifestFile, 'utf8');
  if (digest(raw) !== expectedDigest) throw new Error('Manifest digest mismatch');
  const manifest = JSON.parse(raw) as SnapshotManifest;
  if (
    manifest.schema !== 'area51.host-state.v1' ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    manifest.offlineAcknowledged !== true ||
    JSON.stringify(manifest.scope) !== JSON.stringify(scope) ||
    !Array.isArray(manifest.entries)
  )
    throw new Error('Invalid snapshot manifest');
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      typeof entry.path !== 'string' ||
      entry.path.includes('\\') ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !scope.some((prefix) => entry.path === prefix || entry.path.startsWith(prefix + '/')) ||
      seen.has(entry.path) ||
      !['file', 'directory'].includes(entry.kind) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.executable !== 'boolean' ||
      (entry.kind === 'file' ? !/^[a-f0-9]{64}$/.test(entry.sha256) : entry.size !== 0 || entry.sha256 !== '')
    )
      throw new Error('Invalid snapshot entry');
    seen.add(entry.path);
  }
  const payload = root(path.join(base, 'payload'));
  const actual: Entry[] = [];
  for (const name of fs.readdirSync(payload).sort()) inventory(payload, name, actual);
  // install/ is a structural wrapper, not a state entry.
  const measured = actual
    .filter((entry) => entry.path !== 'install')
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(measured) !== JSON.stringify(manifest.entries)) throw new Error('Payload integrity mismatch');
  return manifest;
}

export function restoreSnapshot(snapshot: string, expectedDigest: string, destination: string): SnapshotManifest {
  const base = root(snapshot);
  if (fs.readFileSync(path.join(base, 'COMPLETE'), 'utf8').trim() !== expectedDigest)
    throw new Error('Incomplete snapshot');
  const manifest = verifySnapshot(base, expectedDigest);
  const target = newDestination(destination, [base]);
  copy(manifest.entries, (entry) => path.join(base, 'payload', entry.path), target);
  fs.writeFileSync(
    path.join(target, 'RESTORED.json'),
    JSON.stringify(
      {
        schema: 'area51.host-state-restored.v1',
        commit: manifest.commit,
        manifestSha256: expectedDigest,
        activationAllowed: false,
        externalWritesReconciled: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return manifest;
}
