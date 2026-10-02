import net from 'node:net';

/** TCP probes may reset without reading the HTTP fixture response. */
export function createVmProbeServer(
  response: string,
  onConnection: () => void,
  onFailure: (error: Error) => void,
): net.Server {
  const server = net.createServer((socket) => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') onFailure(error);
    });
    onConnection();
    socket.end(response);
  });
  server.on('error', onFailure);
  return server;
}
