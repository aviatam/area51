import path from 'path';

import { formatArea51DemoReport, runArea51Demo, type Area51DemoReport } from '../../area51-demo.js';
import { register } from '../registry.js';

interface Area51DemoArgs {
  output_dir?: string;
  json_path?: string;
}

register<Area51DemoArgs, Area51DemoReport>({
  name: 'area51-demo',
  description: 'Run the Area51 Area51 + Incus security demo and write verification artifacts.',
  access: 'open',
  hostOnly: true,
  parseArgs: (raw) => {
    const args = normalizeRawArgs(raw);
    return {
      output_dir: optionalString(args.output_dir, 'output-dir'),
      json_path: optionalString(args.json_path, 'json-path'),
    };
  },
  handler: async (args) => {
    const report = await runArea51Demo({ outputDir: args.output_dir });
    if (args.json_path) {
      const fs = await import('fs');
      fs.mkdirSync(path.dirname(path.resolve(args.json_path)), { recursive: true });
      fs.writeFileSync(path.resolve(args.json_path), JSON.stringify(report, null, 2) + '\n');
    }
    return report;
  },
  formatHuman: formatArea51DemoReport,
});

function normalizeRawArgs(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/-/g, '_'), value]));
}

function optionalString(value: unknown, flag: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`--${flag} requires a value`);
  return value;
}
