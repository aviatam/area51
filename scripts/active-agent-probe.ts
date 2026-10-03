import { isIP } from 'node:net';

/** Executed as the non-root agent, not through the host's privileged Incus API. */
export function activeAgentProbe(input: {
  ownAddress: string;
  peerAddress: string;
  port: number;
  ownFile: string;
  ownMarker: string;
  peerFile: string;
  peerHostFile: string;
}): string {
  if (isIP(input.ownAddress) !== 4 || isIP(input.peerAddress) !== 4 || input.ownAddress === input.peerAddress) {
    throw new Error('distinct IPv4 agent addresses required');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('invalid probe port');
  if (input.ownFile === input.peerFile || input.ownMarker.length === 0)
    throw new Error('distinct private files required');
  return `
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const input = ${JSON.stringify(input)};
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(fs.readFileSync(input.ownFile, 'utf8') === input.ownMarker, 'own private file positive control failed');
assert(!fs.existsSync(input.peerFile), 'peer private file appeared in own workspace');
for (const file of [input.peerHostFile]) {
  let read = false;
  try { fs.readFileSync(file); read = true; } catch {}
  assert(!read, 'peer host private file readable');
  let wrote = false;
  try { fs.writeFileSync(file, 'cross-agent-overwrite'); wrote = true; } catch {}
  assert(!wrote, 'peer host private file writable');
}
const linkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-active-peer-'));
const link = path.join(linkDirectory, 'escape');
fs.symlinkSync(input.peerHostFile, link);
let escaped = false;
try { fs.readFileSync(link); escaped = true; } catch {}
fs.rmSync(linkDirectory, { recursive: true, force: true });
assert(!escaped, 'symlink reached peer private file');
// The guessed guest path is writable in THIS session, not the peer's session.
fs.writeFileSync(input.peerFile, 'cross-agent-overwrite');
assert(fs.readFileSync(input.ownFile, 'utf8') === input.ownMarker, 'own private file changed');
const connect = (host, readBody) => new Promise((resolve) => {
  let connected = false, body = '', done = false;
  const socket = net.connect({ host, port: input.port });
  const finish = () => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve({ connected, body }); };
  const timer = setTimeout(finish, 3000);
  socket.on('connect', () => { connected = true; if (!readBody) finish(); });
  socket.on('data', chunk => body += chunk.toString());
  socket.on('end', finish);
  socket.on('error', finish);
});
const own = await connect(input.ownAddress, true);
assert(own.connected && own.body === input.ownMarker, 'own listening TCP endpoint positive control failed');
const peer = await connect(input.peerAddress, false);
assert(!peer.connected, 'raw TCP reached active peer');
console.log('area51-active-agent-isolation-ok');
`;
}
