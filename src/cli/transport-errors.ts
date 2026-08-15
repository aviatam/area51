import { getLaunchdLabel, getSystemdUnit } from '../install-slug.js';

export function formatTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
    // `bin/area51` cd's to the project root before exec'ing client.ts, so
    // process.cwd() is the install dir — install-slug helpers pick up
    // the right per-checkout suffix.
    return [
      `area51: cannot reach Area51 host (${msg}).`,
      `Is the host running? Start it with: pnpm run dev`,
      `Or, if installed as a service:`,
      `  macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
      `  Linux:  systemctl --user restart ${getSystemdUnit()}`,
      ``,
    ].join('\n');
  }
  return `area51: transport error: ${msg}\n`;
}
