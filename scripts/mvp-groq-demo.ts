/** Bounded host-side Groq demo. VM containment/recovery is proved separately.
 * Owner-started workflow dispatch authorizes one fixed neutral GitHub check. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolActionBroker } from '../src/tool-action-broker.js';

export interface Context {
  repo: string;
  sha: string;
  run: string;
  attempt: string;
}
export interface Proposal {
  schema: 'area51.groq-demo.v1';
  context: Context;
  model: string;
  tool: 'create_neutral_check';
  args: { title: string };
}
function title(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .,:!?_-]{0,119}$/.test(value);
}
export function validateProposal(value: unknown, context: Context): Proposal {
  const p = value as Proposal;
  assert(p && Object.keys(p).sort().join(',') === 'args,context,model,schema,tool');
  assert.equal(p.schema, 'area51.groq-demo.v1');
  assert.deepEqual(p.context, context);
  assert.equal(context.repo, 'aviatam/area51');
  assert.match(context.sha, /^[a-f0-9]{40}$/);
  assert.match(context.run, /^[1-9][0-9]*$/);
  assert.equal(context.attempt, '1', 'Reruns require a fresh workflow run');
  assert.equal(p.model, 'openai/gpt-oss-20b');
  assert.equal(p.tool, 'create_neutral_check');
  assert(p.args && Object.keys(p.args).join(',') === 'title' && title(p.args.title));
  return p;
}
export function digest(p: Proposal): string {
  // Explicit field order: digest cannot change with artifact key ordering.
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: p.schema,
        context: { repo: p.context.repo, sha: p.context.sha, run: p.context.run, attempt: p.context.attempt },
        model: p.model,
        tool: p.tool,
        args: { title: p.args.title },
      }),
    )
    .digest('hex');
}
export async function propose(
  prompt: string,
  key: string,
  context: Context,
  send: typeof fetch = fetch,
): Promise<Proposal> {
  validateProposal(
    {
      schema: 'area51.groq-demo.v1',
      context,
      model: 'openai/gpt-oss-20b',
      tool: 'create_neutral_check',
      args: { title: 'Preflight' },
    },
    context,
  );
  assert(key, 'GROQ_API_KEY repository secret is missing');
  assert(prompt.trim() && prompt.length <= 2000, 'Prompt must contain 1..2000 characters');
  const response = await send('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      temperature: 0,
      max_completion_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'Propose one neutral GitHub demo check. Choose a short English ASCII title describing the user request. This is a proposal, never execution or approval. Do not include secrets.',
        },
        { role: 'user', content: prompt },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'create_neutral_check',
            description: 'Propose a neutral check for the owner-started demo workflow.',
            parameters: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'English ASCII letters, digits, spaces and .,:!?_- only; maximum 120 characters.',
                },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'create_neutral_check' } },
      parallel_tool_calls: false,
    }),
  });
  assert.equal(response.status, 200, `Groq request failed (HTTP ${response.status}); response body withheld`);
  // Never print the raw model/API response or an upstream error body.
  const raw = await response.text();
  assert(raw.length <= 65536, 'Model response too large');
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    // JSON syntax errors may echo upstream content, so deliberately redact them.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Invalid Groq JSON response');
  }
  const calls = result.choices?.[0]?.message?.tool_calls;
  assert(Array.isArray(calls) && calls.length === 1, 'Exactly one proposed tool call required');
  assert.equal(calls[0]?.type, 'function');
  assert.equal(calls[0]?.function?.name, 'create_neutral_check');
  let args;
  try {
    args = JSON.parse(calls[0].function.arguments);
  } catch {
    // Model output is untrusted and must not appear in parser diagnostics.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Invalid model tool arguments');
  }
  return validateProposal(
    { schema: 'area51.groq-demo.v1', context, model: 'openai/gpt-oss-20b', tool: 'create_neutral_check', args },
    context,
  );
}
export interface RunnerContext extends Context {
  event: string;
  actor: string;
  triggeringActor: string;
}
export async function execute(p: Proposal, runner: RunnerContext, token: string, send: typeof fetch = fetch) {
  // These fields come from GitHub's runner environment, never from the artifact
  // or model response. Only the owner's initial manual run may execute.
  assert.equal(runner.event, 'workflow_dispatch', 'Only a manual workflow run may execute');
  assert.equal(runner.actor, 'aviatam', 'Only the repository owner may execute');
  assert.equal(runner.triggeringActor, 'aviatam', 'Only the repository owner may trigger execution');
  const { repo, sha, run, attempt } = runner;
  validateProposal(p, { repo, sha, run, attempt });
  assert(token, 'Temporary GitHub token missing');
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const name = `area51-groq-demo-${p.context.run}`;
  const base = `https://api.github.com/repos/${p.context.repo}`;
  const observations = await send(
    `${base}/commits/${p.context.sha}/check-runs?check_name=${name}&filter=all&per_page=100`,
    {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(observations.status, 200);
  const existing = (await observations.json()) as { total_count: number };
  assert.equal(existing.total_count, 0, 'Existing check: refuse replay');
  const broker = new ToolActionBroker({
    policy: { demo: { create_neutral_check: 'allow' } },
    approvers: [],
    actions: {
      create_neutral_check: {
        validate: (args) => JSON.stringify(args) === JSON.stringify(p.args),
        execute: async () => {
          const response = await send(`${base}/check-runs`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              name,
              head_sha: p.context.sha,
              status: 'completed',
              conclusion: 'neutral',
              output: {
                title: p.args.title,
                summary: `Owner-started Groq demo, no additional approval. Proposal SHA-256: ${digest(p)}`,
              },
            }),
          });
          assert.equal(response.status, 201, 'GitHub write failed; no automatic retry');
          const value = (await response.json()) as { html_url: string };
          assert.match(value.html_url, /^https:\/\/github\.com\/aviatam\/area51\/runs\/[0-9]+$/);
          return value.html_url;
        },
      },
    },
  });
  const result = await broker.bindAgent('demo')(p.tool, p.args);
  assert.equal(result.status, 'executed', 'Ambiguous or failed action: inspect GitHub; do not retry');
  return result;
}
async function main() {
  const context = {
    repo: process.env.GITHUB_REPOSITORY!,
    sha: process.env.GITHUB_SHA!,
    run: process.env.GITHUB_RUN_ID!,
    attempt: process.env.GITHUB_RUN_ATTEMPT!,
  };
  if (process.argv[2] === 'propose') {
    const p = await propose(
      process.env.DEMO_PROMPT || 'Demonstrate an Area51 governed action',
      process.env.GROQ_API_KEY || '',
      context,
    );
    fs.writeFileSync('groq-proposal.json', JSON.stringify(p, null, 2) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Groq proposal\n\nReal Groq tool call succeeded. This proposal step performed no GitHub write.\n\nTitle: ${p.args.title}\n\nCommit: ${context.sha}\n\nProposal SHA-256: ${digest(p)}\n\nThe owner's manual workflow run proceeds to execution without an additional approval. Push runs remain proposal-only.\n\nThis model runs on the host runner. VM containment and recovery evidence is separate.\n`,
      );
    console.log('Groq key validated; one tool proposal received; external action not executed.');
  } else if (process.argv[2] === 'execute') {
    const p = validateProposal(JSON.parse(fs.readFileSync('groq-proposal.json', 'utf8')), context);
    const result = await execute(
      p,
      {
        ...context,
        event: process.env.GITHUB_EVENT_NAME!,
        actor: process.env.GITHUB_ACTOR!,
        triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR!,
      },
      process.env.GITHUB_TOKEN || '',
    );
    if (result.status === 'executed' && process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nDemo check: ${result.value}\n`);
  } else throw new Error('Expected propose or execute');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  void main().catch(() => {
    console.error(
      'Groq demo failed closed. Check secret presence, proposal and owner-started workflow context. Upstream content withheld.',
    );
    process.exitCode = 1;
  });
}
