import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { parse } from 'yaml';
import { digest, execute, ownerApproved, propose, validateProposal, type Proposal } from './mvp-groq-demo.js';

const context = { repo: 'aviatam/area51', sha: 'a'.repeat(40), run: '123', attempt: '1' };
const p: Proposal = {
  schema: 'area51.groq-demo.v1',
  context,
  model: 'openai/gpt-oss-20b',
  tool: 'create_neutral_check',
  args: { title: 'Human approval demo' },
};
const review = () => [
  {
    state: 'approved',
    user: { login: 'aviatam', type: 'User' },
    comment: `approve ${digest(p)}`,
    environments: [{ name: 'area51-demo' }],
  },
];
const completion = (args: unknown = p.args) => ({
  choices: [
    { message: { tool_calls: [{ type: 'function', function: { name: p.tool, arguments: JSON.stringify(args) } }] } },
  ],
});
describe('bounded Groq demo', () => {
  it('keeps push runs proposal-only and requires an environment for dispatch', () => {
    const workflow = parse(fs.readFileSync('.github/workflows/mvp-groq-demo.yml', 'utf8'));
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['approved-action'].if).toBe(
      "github.event_name == 'workflow_dispatch' && github.actor == 'aviatam'",
    );
    expect(workflow.jobs['approved-action'].environment).toBe('area51-demo');
    expect(workflow.jobs['approved-action'].needs).toBe('proposal');
    expect(
      workflow.jobs.proposal.steps.filter((s: { env?: Record<string, string> }) => s.env?.GROQ_API_KEY),
    ).toHaveLength(1);
  });
  it('makes a real-compatible model request but does not execute a tool', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(completion())));
    expect(await propose('Show approval', 'test-secret', context, send)).toEqual(p);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, options] = send.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(options?.body as string).tool_choice.function.name).toBe(p.tool);
  });
  it('refuses a missing key before any request', async () => {
    const send = vi.fn<typeof fetch>();
    await expect(propose('demo', '', context, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('withholds upstream error bodies', async () => {
    await expect(
      propose(
        'demo',
        'test',
        context,
        vi.fn<typeof fetch>().mockResolvedValue(new Response('private detail', { status: 401 })),
      ),
    ).rejects.toThrow('HTTP 401');
  });
  it.each([{ title: 'OK', url: 'https://evil.test' }, { title: 'Bad\npreview' }, { title: 'x'.repeat(121) }])(
    'rejects invalid model arguments %j',
    async (args) => {
      await expect(
        propose(
          'demo',
          'test',
          context,
          vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(completion(args)))),
        ),
      ).rejects.toThrow();
    },
  );
  it('binds the exact source, run and arguments', () => {
    expect(() => validateProposal(p, { ...context, sha: 'b'.repeat(40) })).toThrow();
    expect(() =>
      validateProposal({ ...p, context: { ...context, attempt: '2' } }, { ...context, attempt: '2' }),
    ).toThrow();
    expect(digest({ ...p, args: { title: 'Changed' } })).not.toBe(digest(p));
  });
  it('requires one exact owner review, including digest and environment', () => {
    expect(ownerApproved(review(), digest(p))).toBe(true);
    for (const bad of [
      [],
      [{ ...review()[0], state: 'rejected' }],
      [{ ...review()[0], comment: 'approve' }],
      [{ ...review()[0], user: { login: 'other', type: 'User' } }],
      [...review(), ...review()],
      [{ ...review()[0], environments: [] }],
    ])
      expect(ownerApproved(bad, digest(p))).toBe(false);
  });
  it('performs zero network operations without owner approval', async () => {
    const send = vi.fn<typeof fetch>();
    await expect(execute(p, [], 'token', send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('executes one fixed neutral check after exact approval', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 0 })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ html_url: 'https://github.com/aviatam/area51/runs/456' }), { status: 201 }),
      );
    expect((await execute(p, review(), 'token', send)).status).toBe('executed');
    expect(send).toHaveBeenCalledTimes(2);
    const body = JSON.parse(send.mock.calls[1][1]?.body as string);
    expect(body).toMatchObject({
      head_sha: context.sha,
      name: 'area51-groq-demo-123',
      conclusion: 'neutral',
      output: { title: p.args.title },
    });
  });
  it('refuses an existing check and never retries a failed write', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ total_count: 1 })));
    await expect(execute(p, review(), 'token', send)).rejects.toThrow('refuse replay');
    expect(send).toHaveBeenCalledTimes(1);
    const failing = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"total_count":0}'))
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(execute(p, review(), 'token', failing)).rejects.toThrow('Ambiguous');
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
