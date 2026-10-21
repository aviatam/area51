import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const target = path.join(root, 'container/agent-runner/src/providers');
const files = ['groq.ts', 'groq.registration.test.ts'];
const barrel = path.join(target, 'index.ts');
const line = "import './groq.js';";
const remove = process.argv.includes('--remove');
for (const file of files) {
  const dest = path.join(target, file);
  const source = fs.readFileSync(path.join(here, 'payload', file), 'utf8');
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') !== source)
    throw new Error(`Refusing to overwrite modified ${file}`);
}
for (const file of files) {
  const dest = path.join(target, file);
  if (remove) fs.rmSync(dest, { force: true });
  else fs.copyFileSync(path.join(here, 'payload', file), dest);
}
const lines = fs
  .readFileSync(barrel, 'utf8')
  .split('\n')
  .filter((x) => x !== line);
if (!remove) lines.splice(lines.length - (lines.at(-1) === '' ? 1 : 0), 0, line);
fs.writeFileSync(barrel, lines.join('\n'));
