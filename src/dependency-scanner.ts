import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pins from './dependency-security-pins.json' with { type: 'json' };

const pending = new Map<string, Promise<string>>();

/** Provision only the reviewed host tool. No agent-supplied URL or executable is accepted. */
export function ensureDependencyScanner(toolsDirectory = path.resolve('data/tools')): Promise<string> {
  const key = process.env.AREA51_DEPENDENCY_SCANNER ?? toolsDirectory;
  if (!pending.has(key))
    pending.set(
      key,
      provision(toolsDirectory).finally(() => {
        pending.delete(key);
      }),
    );
  return pending.get(key)!;
}

async function provision(toolsDirectory: string): Promise<string> {
  const asset = pins.assets[`${process.platform}-${process.arch}` as keyof typeof pins.assets];
  if (!asset) throw new Error('Unsupported scanner host platform');
  const destination = process.env.AREA51_DEPENDENCY_SCANNER ?? path.join(toolsDirectory, asset.name);
  if (!path.isAbsolute(destination)) throw new Error('Scanner path must be absolute');
  const verify = (): void => {
    const stat = fs.lstatSync(destination);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 100_000_000 ||
      createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== asset.sha256
    )
      throw new Error('Scanner integrity check failed');
  };
  if (fs.existsSync(destination)) {
    verify();
    return destination;
  }
  // An explicit custom path must already contain the trusted binary.
  if (process.env.AREA51_DEPENDENCY_SCANNER) throw new Error('Configured scanner is missing');
  const response = await fetch(
    `https://github.com/google/osv-scanner/releases/download/v${pins.version}/${asset.name}`,
    {
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok || !response.body) throw new Error('Scanner download failed');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 100_000_000) throw new Error('Scanner download exceeds budget');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Scanner checksum mismatch');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o755, flag: 'wx' });
    // Atomic publication without replacing an existing tool or following a symlink.
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    verify();
    return destination;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
