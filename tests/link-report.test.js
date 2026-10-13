'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reportSentence, relinkBody, run } = require('../link-report.js');

const MARKER = '<!-- tea-test-review:claude -->';
const CLI_LINE =
  'Report and verdict JSON: the `tea-test-review-tea-review-claude` artifact of [this workflow run](https://github.com/o/r/actions/runs/9), once its upload step has finished.';
const BODY = `${MARKER}\n## TeA test quality: Pass\n\nReviewed 2 files.\n\n${CLI_LINE}`;
const URLS = {
  reportUrl: 'https://github.com/o/r/actions/runs/9/artifacts/1',
  jsonUrl: 'https://github.com/o/r/actions/runs/9/artifacts/2',
};

describe('relinkBody', () => {
  test('swaps the CLI sentence for both file links and leaves the rest alone', () => {
    const next = relinkBody(BODY, URLS);
    assert.ok(next.startsWith(`${MARKER}\n## TeA test quality: Pass`));
    assert.ok(next.includes(`[Open the detailed review](${URLS.reportUrl})`));
    assert.ok(next.includes(`[verdict JSON](${URLS.jsonUrl})`));
    assert.ok(!next.includes('once its upload step'));
  });

  test('links the verdict alone when no report was written', () => {
    const next = relinkBody(`${MARKER}\nVerdict JSON: the \`x\` artifact, once its upload step has finished.`, { jsonUrl: URLS.jsonUrl });
    assert.match(next, /Open the \[verdict JSON\]/);
  });

  test('is a no-op without a URL or without the CLI sentence', () => {
    assert.strictEqual(relinkBody(BODY, {}), null);
    assert.strictEqual(relinkBody(`${MARKER}\nThe review wrote no report.`, URLS), null);
  });

  test('is idempotent: a second pass finds no CLI sentence', () => {
    assert.strictEqual(relinkBody(relinkBody(BODY, URLS), URLS), null);
  });

  test('keeps a closing parenthesis in a URL from ending the link early', () => {
    assert.ok(reportSentence({ reportUrl: 'https://x/a)b' }).includes('https://x/a%29b'));
  });
});

describe('run', () => {
  /** Build a pull request event and the action environment for one test run. */
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-report-'));
    const event = path.join(dir, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    return {
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: 't',
      GITHUB_API_URL: 'https://api.test',
      AGENT_TAG: 'claude',
      REPORT_URL: URLS.reportUrl,
      JSON_URL: URLS.jsonUrl,
    };
  }

  /** Record GitHub API calls while modeling both user and installation tokens. */
  function fakeFetch(comments, { patchStatus = 200, login = 'reviewer', restUserStatus = 200, graphqlLogin = login } = {}) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method, body: init.body });
      if (init.method === 'PATCH') return { ok: patchStatus === 200, status: patchStatus, json: async () => ({}), text: async () => 'nope' };
      if (url.endsWith('/user')) return { ok: restUserStatus === 200, status: restUserStatus, json: async () => ({ login }), text: async () => 'nope' };
      if (url.endsWith('/graphql')) return { ok: true, status: 200, json: async () => ({ data: { viewer: graphqlLogin ? { login: graphqlLogin } : null } }), text: async () => '' };
      return { ok: true, status: 200, json: async () => comments.map((comment) => ({ user: { login }, ...comment })), text: async () => '' };
    };
    return calls;
  }

  test('patches the marked comment on the pull request', async () => {
    const calls = fakeFetch([{ id: 1, body: 'unrelated' }, { id: 2, body: BODY }]);
    assert.strictEqual(await run(setup()), 0);
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.url, 'https://api.test/repos/o/r/issues/comments/2');
    assert.ok(JSON.parse(patch.body).body.includes(URLS.reportUrl));
  });

  test('another agent comment is not touched', async () => {
    const calls = fakeFetch([{ id: 3, body: BODY.replace('claude', 'codex') }]);
    await run(setup());
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  });

  test('edits the CLI-owned comment when a different author copied its marker', async () => {
    const calls = fakeFetch([
      { id: 1, body: BODY, user: { login: 'someone-else', type: 'User' } },
      { id: 2, body: BODY, user: { login: 'reviewer', type: 'User' } },
    ]);
    await run(setup());
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.url, 'https://api.test/repos/o/r/issues/comments/2');
  });

  test('uses the installation viewer to distinguish another bot with the same marker', async () => {
    const calls = fakeFetch([
      { id: 1, body: BODY, user: { login: 'other[bot]', type: 'Bot' } },
      { id: 2, body: BODY, user: { login: 'github-actions[bot]', type: 'Bot' } },
    ], { restUserStatus: 403, graphqlLogin: 'github-actions[bot]' });
    await run({ ...setup(), GITHUB_ACTIONS: 'true' });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.url, 'https://api.test/repos/o/r/issues/comments/2');
  });

  test('leaves comments alone when the token identity cannot be determined', async () => {
    const calls = fakeFetch([{ id: 1, body: BODY, user: { login: 'other[bot]', type: 'Bot' } }], {
      restUserStatus: 403,
      graphqlLogin: null,
    });
    await run({ ...setup(), GITHUB_ACTIONS: 'true' });
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  });

  test('uses the Enterprise GraphQL endpoint for an installation token', async () => {
    const calls = fakeFetch([{ id: 2, body: BODY }], { restUserStatus: 403 });
    await run({ ...setup(), GITHUB_API_URL: 'https://ghes.test/api/v3' });
    assert.ok(calls.some((c) => c.url === 'https://ghes.test/api/graphql'));
  });

  test('a failed patch is a warning and never a failure', async () => {
    fakeFetch([{ id: 2, body: BODY }], { patchStatus: 403 });
    assert.strictEqual(await run(setup()), 0);
  });

  test('does nothing, and calls nothing, when the upload produced no URL', async () => {
    const calls = fakeFetch([]);
    assert.strictEqual(await run({ ...setup(), REPORT_URL: '', JSON_URL: '' }), 0);
    assert.strictEqual(calls.length, 0);
  });
});
