'use strict';

/**
 * Points the review comment at the uploaded report.
 *
 * The CLI posts the comment before the artifact upload runs, so the artifact's
 * URL does not exist yet and the comment can only say "once its upload step has
 * finished". This runs after the upload, finds the comment by its hidden marker
 * and swaps that sentence for links to the unzipped files.
 *
 * Cosmetic by contract, like the comment itself: every failure here is a
 * warning, never a red job.
 */

const { resolvePrNumber, parseRepository } = require('./main.js');
const fs = require('fs');

const MAX_PAGES = 10;

/** The CLI's report sentence: "Report and verdict JSON: ..." or, when no report was written, "Verdict JSON: ...". */
const REPORT_LINE = /^(?:Report and verdict JSON|Verdict JSON): .*$/m;

function link(label, url) {
  return url ? `[${label}](${String(url).replaceAll(')', '%29')})` : null;
}

/** The replacement sentence, or null when there is no URL to offer. */
function reportSentence({ reportUrl, jsonUrl }) {
  const report = link('Open the detailed review', reportUrl);
  const verdict = link('verdict JSON', jsonUrl);
  if (report && verdict) return `${report} (markdown, ready to hand to your agent). Also available as ${verdict}.`;
  if (report) return `${report} (markdown, ready to hand to your agent).`;
  if (verdict) return `Open the ${verdict}.`;
  return null;
}

/** The comment body with the CLI's sentence replaced, or null when nothing changes. */
function relinkBody(body, urls) {
  const sentence = reportSentence(urls);
  if (!sentence || !REPORT_LINE.test(body)) return null;
  const next = body.replace(REPORT_LINE, () => sentence);
  return next === body ? null : next;
}

async function api({ apiUrl, token }, method, route, body) {
  const res = await fetch(`${String(apiUrl || 'https://api.github.com').replace(/\/+$/, '')}${route}`, {
    method,
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
      'user-agent': 'muratkeremozcan/tea-test-review',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

/** Match the CLI's ownership check so a quoted marker cannot divert the edit. */
async function commentAuthor(ctx) {
  try {
    const user = await api(ctx, 'GET', '/user');
    return typeof user.login === 'string' && user.login ? user.login : null;
  } catch {
    return null;
  }
}

/** The comment the CLI upserted for this agent, found by marker and author. */
async function findComment(ctx, { owner, repo }, prNumber, marker, { login = null, botOnly = false } = {}) {
  const candidates = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const comments = await api(ctx, 'GET', `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    candidates.push(...comments.filter((c) =>
      typeof c.body === 'string' && c.body.trimStart().startsWith(marker) &&
      (login ? c.user?.login === login : !botOnly || c.user?.type === 'Bot')));
    if (comments.length < 100) break;
  }
  return candidates.find((c) => c.user?.type === 'Bot') ?? candidates[0] ?? null;
}

async function run(env = process.env) {
  const warn = (msg) => console.log(`::warning::tea-test-review: ${msg}`);
  const urls = { reportUrl: env.REPORT_URL || '', jsonUrl: env.JSON_URL || '' };
  if (!urls.reportUrl && !urls.jsonUrl) return 0;
  try {
    const payload = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : null;
    const prNumber = resolvePrNumber(payload, env);
    const repo = parseRepository(env);
    if (!prNumber || !repo || !env.GITHUB_TOKEN || !env.AGENT_TAG) return 0;
    const ctx = { apiUrl: env.GITHUB_API_URL, token: env.GITHUB_TOKEN };
    const login = await commentAuthor(ctx);
    const comment = await findComment(ctx, repo, prNumber, `<!-- tea-test-review:${env.AGENT_TAG} -->`, {
      login,
      botOnly: env.GITHUB_ACTIONS === 'true',
    });
    if (!comment) return 0;
    const body = relinkBody(comment.body, urls);
    if (!body) return 0;
    await api(ctx, 'PATCH', `/repos/${repo.owner}/${repo.repo}/issues/comments/${comment.id}`, { body });
    console.log(`tea-test-review: linked the uploaded report in the review comment on #${prNumber}.`);
  } catch (err) {
    warn(`Could not link the uploaded report in the review comment: ${err.message}. The artifact is still on the run; this is cosmetic.`);
  }
  return 0;
}

if (require.main === module) {
  run().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { REPORT_LINE, reportSentence, relinkBody, findComment, run };
