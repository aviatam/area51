import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(fs.readFileSync(path.join(directory, 'pins.json'), 'utf8'));
const asset = pins.assets[`${process.platform}-${process.arch}`];
if (!asset) throw new Error('Unsupported scanner host platform');
const destination = path.resolve(process.argv[2] ?? path.join(directory, '../../../data/tools', asset.name));
if (fs.existsSync(destination)) {
  if (
    !fs.lstatSync(destination).isFile() ||
    createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== asset.sha256
  )
    throw new Error('Existing scanner differs from pinned release');
  console.log(destination);
} else {
  const response = await fetch(
    `https://github.com/google/osv-scanner/releases/download/v${pins.version}/${asset.name}`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw new Error('Scanner download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Scanner checksum mismatch');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { mode: 0o755, flag: 'wx' });
  console.log(destination);
}
