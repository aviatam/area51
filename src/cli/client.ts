/**
 * `area51` binary entry point.
 *
 * Parses argv, builds a request frame, sends it via the picked transport,
 * formats the response, exits non-zero on error.
 *
 * Usage:
 *   area51 <resource> <verb> [target] [--key value ...] [--json]
 *
 * Examples:
 *   area51 groups list
 *   area51 groups get abc123
 *   area51 groups create --name foo --folder bar
 *   area51 groups update abc123 --name baz
 *   area51 help
 *   area51 groups help
 */
import { randomUUID } from 'crypto';

import { formatResponse } from './format.js';
import type { RequestFrame } from './frame.js';
import { SocketTransport } from './socket-client.js';
import type { Transport } from './transport.js';
import { formatTransportError } from './transport-errors.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, args, json } = parseArgv(argv);
  const req: RequestFrame = { id: randomUUID(), command, args };
  const transport: Transport = pickTransport();

  let res;
  try {
    res = await transport.sendFrame(req);
  } catch (e) {
    process.stderr.write(formatTransportError(e));
    process.exit(2);
  }

  const output =
    !json && res.ok && res.human !== undefined
      ? res.human + '\n' // server-rendered view — print verbatim
      : formatResponse(res, json ? 'json' : 'human');
  // Exit only after stdout drains: process.exit() discards buffered pipe
  // writes, silently truncating any response past the 64KB pipe buffer
  // (bit `area51 sessions list --json` at scale).
  process.stdout.write(output, () => process.exit(res.ok ? 0 : 1));
}

function pickTransport(): Transport {
  return new SocketTransport();
}

function parseArgv(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
      continue;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    process.stderr.write('area51: missing command\n');
    printUsage();
    process.exit(2);
  }

  // Join all positionals with dashes to form the command name.
  // If the full name isn't a command, the dispatcher will try trimming
  // the last segment and using it as the target ID (e.g. `groups get abc`
  // → command "groups-get", id "abc").
  const command = positional.join('-');

  return { command, args, json };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: area51 <resource> <verb> [target] [--key value ...] [--json]',
      '',
      'Run `area51 help` to list available resources and commands.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`area51: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
