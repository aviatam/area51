import { once } from 'node:events';
import net from 'node:net';
import { expect, it } from 'vitest';

import { createVmProbeServer } from './vm-probe-server.js';

it('survives a reset probe, counts it, and serves the next positive control', async () => {
  let connections = 0;
  const failures: Error[] = [];
  const server = createVmProbeServer(
    'canary\n',
    () => connections++,
    (error) => failures.push(error),
  );
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;
    const accepted = once(server, 'connection');
    const probe = net.connect(port, '127.0.0.1');
    await once(probe, 'connect');
    const [peer] = (await accepted) as [net.Socket];
    const peerClosed = once(peer, 'close').catch(() => undefined);
    probe.resetAndDestroy();
    await peerClosed;
    const control = net.connect(port, '127.0.0.1');
    let response = '';
    control.on('data', (chunk) => (response += chunk.toString()));
    await once(control, 'end');
    control.destroy();
    expect(response).toBe('canary\n');
    expect(connections).toBe(2);
    expect(failures).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('reports listener failures rather than treating them as a denied endpoint', async () => {
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = (occupied.address() as net.AddressInfo).port;
  let probe: net.Server | undefined;
  try {
    const failure = new Promise<Error>((resolve) => {
      probe = createVmProbeServer('', () => {}, resolve);
      probe.listen(port, '127.0.0.1');
    });
    expect(((await failure) as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
  } finally {
    probe?.close();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
