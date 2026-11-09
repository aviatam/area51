// Unit/integration tests must mock external services. Local fixture servers are allowed.
// This is an accidental-network regression guard, not a security sandbox for test code.
import net from 'node:net';

const localHost = (host) => {
  const normalized = String(host ?? 'localhost')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1';
};
const reject = () => new Error('External network disabled in tests; mock the service or use a loopback fixture');
const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!localHost(url.hostname)) return Promise.reject(reject());
  return realFetch.call(this, input, ...args);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let options = args[0];
  // Node internally passes normalized [options, callback] tuples.
  if (Array.isArray(options)) options = options[0];
  if (typeof options === 'object' && options !== null) {
    if (!options.path && options.fd === undefined && !localHost(options.host)) throw reject();
  } else if (typeof options === 'number') {
    if (typeof args[1] === 'string' && !localHost(args[1])) throw reject();
  } else if (typeof options !== 'string') {
    throw reject();
  }
  return realConnect.apply(this, args);
};

// Child Node CLIs inherit the same guard; never invoke package-manager resolution
// merely to execute a test fixture. Native subprocesses still require local mocks.
const preload = `--import=${import.meta.url}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(preload))
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
