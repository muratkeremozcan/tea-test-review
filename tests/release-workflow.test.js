'use strict';

/**
 * Tests for the Release workflow. It writes tags and releases with the repository token, so it
 * keeps its guards: least privilege per job, write jobs that run no repository code, the unit tests
 * and the consumer smoke before a draft and again before the floating major tag moves, the
 * immutable and Marketplace checks, and the tag handling that moves an exact tag only with the
 * unpublished draft this workflow created for it and never rolls a major back. The repository has
 * no dependencies, so the steps are read from the workflow text.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEXT = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const JOBS_TEXT = TEXT.slice(TEXT.indexOf('\njobs:\n'));
const JOB_NAMES = [...JOBS_TEXT.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);

/** The text of one job, from its key to the next job's key. */
function jobText(job) {
  const start = JOBS_TEXT.indexOf(`\n  ${job}:\n`);
  assert.ok(start > -1, `the workflow has the job ${job}`);
  const next = JOB_NAMES[JOB_NAMES.indexOf(job) + 1];
  return JOBS_TEXT.slice(start, next ? JOBS_TEXT.indexOf(`\n  ${next}:\n`) : undefined);
}

const DRAFT_JOB = jobText('draft');

/**
 * Every step of a job, by position, as `{ name, text, env, run }` with `run` dedented the way the
 * runner reads it. A step that starts with a key other than its name, or a name used twice, fails
 * here, so no step escapes a check that looks steps up by name.
 */
function steps(job) {
  const text = jobText(job);
  const starts = [...text.matchAll(/^ {6}- /gm)].map((match) => match.index);
  const parsed = starts.map((start, i) => {
    const lines = text.slice(start, starts[i + 1]).trimEnd().split('\n');
    const named = /^ {6}- name: (.+)$/.exec(lines[0]);
    assert.ok(named, `${job}: every step starts with its name, got "${lines[0].trim()}"`);

    const env = {};
    const envAt = lines.indexOf('        env:');
    if (envAt > -1) {
      for (const line of lines.slice(envAt + 1)) {
        const found = /^ {10}([A-Z_]+): (.+)$/.exec(line);
        if (!found) break;
        env[found[1]] = found[2];
      }
    }

    let run;
    const runAt = lines.findIndex((line) => line.startsWith('        run: '));
    if (runAt > -1 && lines[runAt] === '        run: |') {
      const body = [];
      for (const line of lines.slice(runAt + 1)) {
        if (line !== '' && !line.startsWith(' '.repeat(10))) break;
        body.push(line.slice(10));
      }
      run = `${body.join('\n').trimEnd()}\n`;
    } else if (runAt > -1) {
      run = lines[runAt].slice('        run: '.length);
      assert.match(run, /^[^|>'"&*!]/, `${job}: ${named[1]} uses run: | or a plain one-line run`);
    }
    return { name: named[1], text: lines.join('\n'), env, run };
  });
  const names = parsed.map((s) => s.name);
  assert.strictEqual(new Set(names).size, names.length, `${job}: step names are unique`);
  return parsed;
}

const stepNames = (job) => steps(job).map((s) => s.name);
const stepIndex = (job, name) => {
  const index = stepNames(job).indexOf(name);
  assert.ok(index > -1, `${job} has the step ${name}`);
  return index;
};
const step = (job, name) => steps(job)[stepIndex(job, name)];

describe('triggers and permissions', () => {
  test('prepares from a bump choice and promotes only published releases', () => {
    assert.match(TEXT, /workflow_dispatch:/);
    assert.match(TEXT, /options:\n\s+- patch\n\s+- minor\n\s+- major/);
    assert.match(TEXT, /release:\n\s+types: \[published\]/);
  });

  test('never cancels a release run, running or pending', () => {
    assert.match(
      TEXT,
      /^concurrency:\n {2}group: tea-test-review-release-\$\{\{ github\.event\.release\.tag_name \|\| github\.event_name \}\}\n {2}cancel-in-progress: false$/m,
      'a publication has a group of its own, so no later run cancels it while it is pending'
    );
  });

  test('grants nothing by default and each job only the contents access it needs', () => {
    assert.match(TEXT, /^permissions: \{\}$/m);
    assert.deepStrictEqual(JOB_NAMES, ['prepare', 'draft', 'verify', 'promote']);
    const access = { prepare: 'read', draft: 'write', verify: 'read', promote: 'write' };
    for (const [job, level] of Object.entries(access)) {
      assert.match(jobText(job), new RegExp(`\\n {4}permissions:\\n {6}contents: ${level}\\n {4}[a-z]`), job);
    }
  });

  test('the jobs that write run no repository code', () => {
    for (const job of ['draft', 'promote']) {
      // The whole job text, so no YAML form of a step hides a command from this check.
      assert.doesNotMatch(jobText(job), /uses:|\bnode\b|\bnpm\b|scripts\//, job);
      for (const { name, run } of steps(job)) {
        assert.ok(run, `${job}: ${name} is a run step`);
        assert.doesNotMatch(run, /\bnode\b|\bnpm\b|scripts\//, `${job}: ${name}`);
      }
    }
  });

  test('the dispatch jobs and the publication jobs never run on the other event', () => {
    const condition = (job) => /\n {4}if: (.+)\n/.exec(jobText(job))[1];
    for (const job of ['prepare', 'draft']) {
      assert.strictEqual(condition(job), "github.event_name == 'workflow_dispatch'");
    }
    const published = "github.event_name == 'release' && github.event.action == 'published'";
    assert.strictEqual(condition('verify'), published);
    assert.ok(condition('promote').startsWith(`${published} && `), 'promote also needs a current release');
    assert.match(jobText('draft'), /\n {4}needs: prepare\n/);
    assert.match(jobText('promote'), /\n {4}needs: verify\n/);
  });

  test('pins every external action to a full commit SHA', () => {
    const external = [...TEXT.matchAll(/^\s+uses: (?!\.\/)(\S+)/gm)].map((match) => match[1]);
    assert.ok(external.length > 0);
    for (const uses of external) assert.match(uses, /@[0-9a-f]{40}$/);
  });

  test('checks out without persisting the token', () => {
    for (const job of ['prepare', 'verify']) {
      const checkout = step(job, stepNames(job)[0]).text;
      assert.match(checkout, /uses: actions\/checkout@/);
      assert.match(checkout, /persist-credentials: false/);
      assert.match(checkout, /fetch-depth: 0/);
    }
    assert.match(
      step('verify', 'Check out the published release').text,
      /ref: \$\{\{ github\.event\.release\.tag_name \}\}/,
      'verify tests the published tag'
    );
  });
});

describe('gates', () => {
  test('prepare requires main before it runs anything', () => {
    assert.ok(stepIndex('prepare', 'Require the default branch') < stepIndex('prepare', 'Run unit tests'));
    assert.match(step('prepare', 'Require the default branch').run, /"\$GITHUB_REF" != 'refs\/heads\/main'/);
  });

  test('verify validates the release before it runs repository code', () => {
    assert.ok(stepIndex('verify', 'Validate the immutable release') < stepIndex('verify', 'Run unit tests'));
  });

  for (const job of ['prepare', 'verify']) {
    test(`${job} runs the unit tests and then the deterministic consumer smoke`, () => {
      assert.ok(stepIndex(job, 'Run unit tests') < stepIndex(job, 'Run deterministic consumer smoke'));
      assert.strictEqual(step(job, 'Run unit tests').text.split('\n')[1], '        run: node --test tests/*.test.js');
      const smoke = step(job, 'Run deterministic consumer smoke').text;
      assert.match(smoke, /uses: \.\/\n/);
      assert.match(smoke, /comment: 'false'/);
      assert.match(smoke, /upload-report: 'false'/);
      assert.match(smoke, /extra-args: --agent none --files tests\/main\.test\.js/);
    });
  }

  test('prepare derives the version only after the gates and the smoke pass', () => {
    assert.ok(stepIndex('prepare', 'Run deterministic consumer smoke') < stepIndex('prepare', 'Derive the next exact version'));
    assert.match(jobText('prepare'), /release-sha: \$\{\{ github\.sha \}\}/);
  });

  test('verify gates the tag shape, main ancestry, immutability, action.yml and ordering', () => {
    const { run } = step('verify', 'Validate the immutable release');
    assert.match(run, /\^v\(0\|\[1-9\]\[0-9\]\*\)/);
    assert.match(run, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
    assert.match(run, /--jq \.immutable\)/);
    assert.match(run, /if \[ "\$immutable" != 'true' \]/);
    assert.match(run, /contents\/action\.yml\?ref=\$TAG/);
    assert.match(run, /release-version\.js compare "\$TAG" "\$highest_tag"/);
    assert.match(run, /if \[ "\$release_order" -lt 0 \]/);
  });

  test('tells the maintainer how to recover from a release published while immutability was off', () => {
    const { run } = step('verify', 'Validate the immutable release');
    const summary = run.slice(run.indexOf('if [ "$immutable" != \'true\' ]'));
    assert.match(summary, /was published while release immutability was off, so \$major stays put/);
    assert.match(summary, /Enable release immutability, then release the next patch/);
    assert.match(summary, />> "\$GITHUB_STEP_SUMMARY"/);
  });
});

describe('Marketplace and the floating major tag', () => {
  test('checks the Marketplace page of this action for the exact tag before moving the major', () => {
    const { run } = step('verify', 'Verify Marketplace publication');
    assert.match(run, /'https:\/\/github\.com\/marketplace\/actions\/tea-test-review'/);
    assert.match(run, /grep --fixed-strings --word-regexp --quiet "\$TAG"/);
    assert.match(run, /tick Publish this Action to the GitHub Marketplace, click Update release/);
    assert.deepStrictEqual(stepNames('verify').slice(-2), ['Verify Marketplace publication', 'Recheck the release order']);
  });

  test('peels annotated tags to commits before it compares them', () => {
    const { run } = step('promote', 'Move the floating major tag');
    assert.match(run, /while \[ "\$object_type" = 'tag' \]/);
    assert.match(run, /exact_sha=\$\(resolve_tag_commit "\$TAG"\)/);
    assert.match(run, /major_sha=\$\(resolve_tag_commit "\$MAJOR"\)/);
  });

  test('verifies the exact and the floating tag resolve to the release commit', () => {
    assert.strictEqual(stepNames('promote')[1], 'Verify exact and floating references');
    const { run } = step('promote', 'Verify exact and floating references');
    assert.match(run, /test "\$exact_sha" = "\$RELEASE_SHA"/);
    assert.match(run, /test "\$major_sha" = "\$RELEASE_SHA"/);
    assert.match(run, /contents\/action\.yml\?ref=\$MAJOR/);
    assert.doesNotMatch(TEXT, /gh release create "\$MAJOR"/);
  });
});

describe('the draft', () => {
  test('creates a missing exact tag before a new draft with generated notes', () => {
    const releaseCreation = DRAFT_JOB.indexOf('gh release create "$TAG"');
    const newDraftTagGuard = DRAFT_JOB.lastIndexOf('if [ "$tag_state" = \'missing\' ]; then', releaseCreation);

    assert.ok(newDraftTagGuard > -1 && newDraftTagGuard < releaseCreation);
    assert.match(DRAFT_JOB.slice(newDraftTagGuard, releaseCreation), /create_exact_tag/);
    assert.match(DRAFT_JOB, /--draft/);
    assert.match(DRAFT_JOB, /--generate-notes/);
    assert.match(DRAFT_JOB, /--target "\$RELEASE_SHA"/);
    assert.doesNotMatch(DRAFT_JOB, /--verify-tag/);
  });

test('checks a found draft and its tag before the first write, and fixes the tag before the notes', () => {
  const existingDraftStart = DRAFT_JOB.indexOf('if release=$(gh release view "$TAG"');
  const existingDraftEnd = DRAFT_JOB.indexOf('# Let the Releases API');
  const existingDraft = DRAFT_JOB.slice(existingDraftStart, existingDraftEnd);
  const at = (text) => {
    const index = existingDraft.indexOf(text);
    assert.ok(index > -1, `the found-draft branch has ${text}`);
    return index;
  };
  const firstWrite = Math.min(
    ...['move_exact_tag', 'create_exact_tag', 'releases/generate-notes', '-F body=@'].map(at)
  );

  assert.match(existingDraft, /--json author,body,databaseId,isDraft,tagName,targetCommitish,url/);
  assert.ok(at('validate_draft "$release"') < firstWrite);
  assert.ok(at('[ "$release_author" != \'github-actions[bot]\' ]') < firstWrite);
  assert.ok(at('[ "$existing_type" != \'commit\' ]') < firstWrite);
  assert.ok(at('verify_exact_tag') < at('releases/generate-notes'));
});
  test("verifies the created draft's own tag and accepts its synthetic URL", () => {
    const releaseCreation = DRAFT_JOB.indexOf('gh release create "$TAG"');
    const releaseVerification = DRAFT_JOB.indexOf('created_release=$(gh release view "$TAG"');
    const successSummary = DRAFT_JOB.lastIndexOf('publish_steps "$url"');
    const verificationBlock = DRAFT_JOB.slice(releaseVerification, successSummary);

    assert.ok(releaseCreation > -1 && releaseCreation < releaseVerification);
    assert.ok(releaseVerification < successSummary);
    assert.match(verificationBlock, /--json author,isDraft,tagName,targetCommitish,url/);
    assert.match(verificationBlock, /validate_draft "\$created_release"/);
    assert.match(verificationBlock, /if \[ "\$created_url" != "\$url" \]/);
    assert.doesNotMatch(DRAFT_JOB, /expected_url|releases\/tag\/\$TAG/);
  });

  test('tells the maintainer what to click to publish to the Marketplace', () => {
    assert.match(DRAFT_JOB, /Tick Publish this Action to the GitHub Marketplace/);
    assert.match(DRAFT_JOB, /Click Publish release/);
    assert.match(DRAFT_JOB, />> "\$GITHUB_STEP_SUMMARY"/);
    assert.strictEqual((DRAFT_JOB.match(/publish_steps "\$url"/g) || []).length, 2, 'a new and a found draft');
  });
});

/**
 * A fake `gh` on PATH for the shell of a workflow step: `gh api` over a JSON state of releases,
 * refs and annotated tag objects, with `--jq` applied by the real jq. Every call is logged, so a
 * test can tell whether the step changed a ref.
 */
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
const fail = (message) => {
  process.stderr.write('gh: ' + message + '\\n');
  process.exit(1);
};
const notes = (sha) => 'Changes up to ' + sha;
if (args[0] === 'release') {
  // gh release view and create over the same releases, by tag name, drafts included.
  const [, command, tag] = args;
  const options = {};
  for (let i = 3; i < args.length; i++) {
    const name = args[i].slice(2);
    options[name] = name === 'draft' || name === 'generate-notes' ? true : args[++i];
  }
  const release = state.releases.find((r) => r.tag_name === tag);
  if (command === 'view') {
    if (!release) fail('release not found');
    const fieldsOf = {
      author: { login: release.author },
      body: release.body,
      databaseId: release.id,
      isDraft: release.draft,
      tagName: release.tag_name,
      targetCommitish: release.target_commitish,
      url: release.url,
    };
    const picked = {};
    for (const name of (options.json || 'url').split(',')) picked[name] = fieldsOf[name];
    process.stdout.write(JSON.stringify(picked) + '\\n');
    // What a maintainer may do to the draft right after a run looked it up.
    if (state.onView === 'publish') {
      release.draft = false;
      delete state.onView;
      save();
    }
  } else if (command === 'create') {
    if (release) fail('a release with the same tag name already exists');
    const url = 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/releases/tag/untagged-new';
    const ref = state.refs[tag];
    state.releases.unshift({
      id: 100 + state.releases.length,
      tag_name: tag,
      draft: true,
      prerelease: false,
      author: 'github-actions[bot]',
      target_commitish: options.target,
      url,
      name: options.title,
      body: notes(ref ? ref.sha : options.target),
    });
    save();
    process.stdout.write(url + '\\n');
  } else fail('unexpected release command ' + command);
  process.exit(0);
}
if (args[0] !== 'api') fail('unexpected command ' + args.join(' '));
let method = 'GET';
let jq = null;
let endpoint = null;
let paginate = false;
const fields = {};
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--method') method = args[++i];
  else if (arg === '--jq') jq = args[++i];
  else if (arg === '--paginate') paginate = true;
  else if (arg === '-f' || arg === '-F') {
    const [name, ...value] = args[++i].split('=');
    fields[name] = value.join('=');
    if (arg === '-F' && fields[name].startsWith('@')) {
      fields[name] = fs.readFileSync(fields[name].slice(1), 'utf8').trim();
    }
  } else endpoint = arg;
}
const repo = 'repos/' + process.env.GITHUB_REPOSITORY + '/';
if (!endpoint || !endpoint.startsWith(repo)) fail('unexpected endpoint ' + endpoint);
const route = endpoint.slice(repo.length);
const print = (body) => {
  if (jq === null) return process.stdout.write(JSON.stringify(body) + '\\n');
  const out = spawnSync('jq', ['-r', jq], { input: JSON.stringify(body), encoding: 'utf8' });
  if (out.status !== 0) fail('jq failed: ' + out.stderr);
  process.stdout.write(out.stdout);
};
let body;
let match;
if (method === 'GET' && route === 'releases?per_page=100') {
  if (state.releasesDown) fail('Server Error (HTTP 502)');
  // Like gh, --paginate applies --jq to every page; without it only the first page arrives.
  const size = state.pageSize || 100;
  const pages = [];
  for (let i = 0; i < state.releases.length; i += size) pages.push(state.releases.slice(i, i + size));
  for (const page of paginate ? pages : pages.slice(0, 1)) print(page);
  process.exit(0);
} else if (method === 'GET' && (match = /^git\\/ref\\/tags\\/(.+)$/.exec(route))) {
  const ref = state.refs[match[1]];
  if (!ref) fail('Not Found (HTTP 404)');
  body = { ref: 'refs/tags/' + match[1], object: ref };
} else if (method === 'GET' && (match = /^git\\/tags\\/([0-9a-f]+)$/.exec(route))) {
  const tag = state.tags[match[1]];
  if (!tag) fail('Not Found (HTTP 404)');
  body = { sha: match[1], object: tag };
} else if (method === 'DELETE' && (match = /^git\\/refs\\/tags\\/(.+)$/.exec(route))) {
  if (!state.refs[match[1]]) fail('Reference does not exist (HTTP 422)');
  delete state.refs[match[1]];
  save();
  process.exit(0);
} else if ((match = /^releases\\/([0-9]+)$/.exec(route)) && ['GET', 'PATCH'].includes(method)) {
  const release = state.releases.find((r) => r.id === Number(match[1]));
  if (!release) fail('Not Found (HTTP 404)');
  if (method === 'PATCH') {
    // Like GitHub, a release update without tag_name leaves a draft with no tag.
    release.tag_name = fields.tag_name === undefined ? '' : fields.tag_name;
    release.target_commitish = fields.target_commitish;
    release.name = fields.name;
    release.body = fields.body;
    save();
  }
  body = {
    id: release.id,
    draft: release.draft,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    html_url: release.url,
    author: { login: release.author },
    body: release.body,
  };
} else if (method === 'POST' && route === 'releases/generate-notes') {
  // Like GitHub, the notes of an existing tag end at that tag and ignore target_commitish.
  if (state.notesDown) fail('Server Error (HTTP 502)');
  const ref = state.refs[fields.tag_name];
  body = { name: fields.tag_name, body: notes(ref ? ref.sha : fields.target_commitish) };
} else if (method === 'PATCH' && (match = /^git\\/refs\\/tags\\/(.+)$/.exec(route))) {
  if (!state.refs[match[1]]) fail('Reference does not exist (HTTP 422)');
  if (state.immutable && state.releases.some((r) => r.tag_name === match[1] && !r.draft)) {
    fail('Cannot update a tag of an immutable release (HTTP 422)');
  }
  state.refs[match[1]] = { type: 'commit', sha: fields.sha };
  // What a maintainer may do to the draft while a run moves its tag, once.
  const raced = state.releases.findIndex((r) => r.tag_name === match[1]);
  if (state.onTagMove === 'publish') state.releases[raced].draft = false;
  if (['replace', 'retag'].includes(state.onTagMove)) {
    state.releases.splice(raced, 1, { ...state.releases[raced], id: 99, author: 'maintainer' });
  }
  if (state.onTagMove === 'retag') state.refs[match[1]] = { type: 'commit', sha: state.retagTo };
  delete state.onTagMove;
  // A move GitHub made whose response never reached the run, once.
  const lost = state.lostResponse;
  delete state.lostResponse;
  save();
  if (lost) fail('connection reset by peer');
  body = {};
} else if (method === 'POST' && route === 'git/refs') {
  const name = fields.ref.replace(/^refs\\/tags\\//, '');
  if (state.refs[name]) fail('Reference already exists (HTTP 422)');
  state.refs[name] = { type: 'commit', sha: fields.sha };
  save();
  body = {};
} else fail('unexpected call ' + method + ' ' + route);
print(body);
`;

const SHA = {
  v100: 'a'.repeat(40),
  v101: 'b'.repeat(40),
  v200: 'c'.repeat(40),
  other: 'd'.repeat(40),
};
const ANNOTATED = 'e'.repeat(40);

const published = (...tags) => tags.map((tag) => ({ tag_name: tag, draft: false, prerelease: false }));

/**
 * Runs the shell of `workflowStep` the way the runner does, with the fake `gh` over `state`.
 * `values` maps the expressions of the step's env, such as `needs.verify.outputs.tag`, to their
 * values. Returns `{ status, stderr, state, calls, mutations, output, summary }`.
 */
function runStep(workflowStep, state, values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttr-release-step-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const file = (name) => path.join(dir, name);
  fs.writeFileSync(file('state.json'), JSON.stringify(state));
  for (const name of ['calls', 'output', 'summary']) fs.writeFileSync(file(name), '');
  const env = {};
  for (const [name, expression] of Object.entries(workflowStep.env)) {
    const found = /^\$\{\{ (.+) \}\}$/.exec(expression);
    assert.ok(found && found[1] in values, `the test gives ${expression}`);
    env[name] = values[found[1]];
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', workflowStep.run], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: process.env.HOME,
      GITHUB_REPOSITORY: 'owner/action',
      GITHUB_OUTPUT: file('output'),
      GITHUB_STEP_SUMMARY: file('summary'),
      RUNNER_TEMP: dir,
      MOCK_STATE: file('state.json'),
      MOCK_LOG: file('calls'),
      ...env,
    },
  });
  const calls = fs
    .readFileSync(file('calls'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const run = {
    status: result.status,
    stderr: result.stderr,
    state: JSON.parse(fs.readFileSync(file('state.json'), 'utf8')),
    calls,
    // Generating notes reads; it writes nothing.
    mutations: calls.filter(
      (c) =>
        (['PATCH', 'POST', 'DELETE'].some((method) => c.includes(method)) &&
          !c.some((arg) => arg.endsWith('/releases/generate-notes'))) ||
        (c[0] === 'release' && c[1] !== 'view')
    ),
    output: fs.readFileSync(file('output'), 'utf8'),
    summary: fs.readFileSync(file('summary'), 'utf8'),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return run;
}

/**
 * The promote step of `tag`, given the outputs its verify job wrote when it started, which may be
 * stale by the time the promotion runs.
 */
function promote(state, { tag, sha }) {
  const major = tag.split('.')[0];
  return runStep(step('promote', 'Move the floating major tag'), state, {
    'github.token': 'token',
    'needs.verify.outputs.tag': tag,
    'needs.verify.outputs.major': major,
    'needs.verify.outputs.release-sha': sha,
  });
}

describe('promoting the floating major against the published releases', () => {
  test('promotions of one major run one at a time, and only for a release still the highest', () => {
    assert.match(
      jobText('promote'),
      /\n {4}concurrency:\n {6}group: tea-test-review-promote-\$\{\{ needs\.verify\.outputs\.major \}\}\n {6}cancel-in-progress: false\n {6}queue: max\n/
    );
    assert.match(jobText('promote'), /\n {4}if: .*needs\.verify\.outputs\.current == 'true'\n/);
    assert.match(jobText('verify'), /\n {6}current: \$\{\{ steps\.order\.outputs\.current \}\}\n/);
    assert.match(step('verify', 'Recheck the release order').text, /\n {8}id: order\n/);
  });

  test('an older release promoted after a newer one leaves the major on the newer', () => {
    // v1.0.0 verified while it was the highest; v1.0.1 published, verified and promoted first.
    const state = {
      releases: published('v10.0.0', 'v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /v1\.0\.0 is older than v1\.0\.1/);
    assert.deepStrictEqual(run.mutations, []);
    assert.strictEqual(run.state.refs.v1.sha, SHA.v101);
  });

  test('the highest release moves its major, and a later older promotion does not undo it', () => {
    const state = {
      releases: published('v1.0.0', 'v1.0.1'),
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        // An annotated exact tag peels to its commit.
        'v1.0.1': { type: 'tag', sha: ANNOTATED },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: { [ANNOTATED]: { type: 'commit', sha: SHA.v101 } },
    };
    const newer = promote(state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.strictEqual(newer.status, 0, newer.stderr);
    assert.strictEqual(newer.mutations.length, 1);
    assert.ok(newer.mutations[0].includes('PATCH'));
    assert.strictEqual(newer.state.refs.v1.sha, SHA.v101);

    const older = promote(newer.state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(older.status, 0);
    assert.deepStrictEqual(older.mutations, []);
    assert.strictEqual(older.state.refs.v1.sha, SHA.v101);
  });

  test('the highest release is chosen by number, among the releases of its own major only', () => {
    const state = {
      // Lexically v1.0.9 sorts after v1.0.10, and v10.2.0 starts with v1.
      releases: published('v10.2.0', 'v1.0.9', 'v1.0.10'),
      refs: {
        'v1.0.9': { type: 'commit', sha: SHA.v100 },
        'v1.0.10': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: {},
    };
    const newer = promote(state, { tag: 'v1.0.10', sha: SHA.v101 });
    assert.strictEqual(newer.status, 0, newer.stderr);
    assert.strictEqual(newer.state.refs.v1.sha, SHA.v101);

    const older = promote(newer.state, { tag: 'v1.0.9', sha: SHA.v100 });
    assert.notStrictEqual(older.status, 0);
    assert.match(older.stderr, /v1\.0\.9 is older than v1\.0\.10/);
    assert.deepStrictEqual(older.mutations, []);
  });

  test('a newer release on a later page of the releases still keeps the major', () => {
    const state = {
      releases: published('v1.0.0', 'v1.0.1'),
      pageSize: 1,
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /v1\.0\.0 is older than v1\.0\.1/);
    assert.deepStrictEqual(run.mutations, []);
  });

  test('a major with no tag yet is created at the release', () => {
    const state = {
      releases: published('v1.0.0'),
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.mutations.length, 1);
    assert.ok(run.mutations[0].includes('POST'));
    assert.deepStrictEqual(run.state.refs.v1, { type: 'commit', sha: SHA.v100 });
  });

  test('two majors progress independently', () => {
    const state = {
      releases: published('v2.0.0', 'v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        'v2.0.0': { type: 'commit', sha: SHA.v200 },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: {},
    };
    const two = promote(state, { tag: 'v2.0.0', sha: SHA.v200 });
    assert.strictEqual(two.status, 0, two.stderr);
    assert.strictEqual(two.state.refs.v2.sha, SHA.v200);
    assert.strictEqual(two.state.refs.v1.sha, SHA.v100, 'v2 leaves v1 alone');

    // v2.0.0 is the highest release overall; v1.0.1 is still the highest of v1.
    const one = promote(two.state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.strictEqual(one.status, 0, one.stderr);
    assert.strictEqual(one.state.refs.v1.sha, SHA.v101);
    assert.strictEqual(one.state.refs.v2.sha, SHA.v200, 'v1 leaves v2 alone');
  });

  test('a repeated promotion to the same commit succeeds and changes nothing', () => {
    const state = {
      releases: published('v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.1': { type: 'commit', sha: SHA.v101 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.mutations, []);
    assert.match(run.summary, /v1 already resolves to b{40}/);
  });

  test('verify fails a release that a newer one superseded while it was verified', () => {
    const recheck = step('verify', 'Recheck the release order');
    const values = (tag) => ({
      'github.token': 'token',
      'steps.release.outputs.tag': tag,
      'steps.release.outputs.major': 'v1',
    });
    const state = { releases: published('v1.0.1', 'v1.0.0', 'v10.0.0'), refs: {}, tags: {} };

    const older = runStep(recheck, state, values('v1.0.0'));
    assert.notStrictEqual(older.status, 0);
    assert.match(older.stderr, /v1\.0\.0 was superseded by v1\.0\.1/);
    assert.strictEqual(older.output, '', 'a superseded release has no current output');

    const current = runStep(recheck, state, values('v1.0.1'));
    assert.strictEqual(current.status, 0, current.stderr);
    assert.strictEqual(current.output, 'current=true\n');

    const paged = runStep(recheck, { ...state, releases: published('v1.0.0', 'v1.0.1'), pageSize: 1 }, values('v1.0.0'));
    assert.notStrictEqual(paged.status, 0, 'the newer release is on the second page');
    assert.match(paged.stderr, /v1\.0\.0 was superseded by v1\.0\.1/);
  });

  test('a releases API that fails stops the promotion before any tag moves', () => {
    // v1.0.1 is the highest, but the read fails; a promotion of the older v1.0.0 must not proceed.
    const state = {
      releases: published('v1.0.1', 'v1.0.0'),
      releasesDown: true,
      refs: {
        'v1.0.0': { type: 'commit', sha: SHA.v100 },
        v1: { type: 'commit', sha: SHA.v101 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.0', sha: SHA.v100 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /HTTP 502/);
    assert.deepStrictEqual(run.mutations, []);
    assert.strictEqual(run.state.refs.v1.sha, SHA.v101);
  });

  test('an exact tag on another commit aborts the promotion', () => {
    const state = {
      releases: published('v1.0.1', 'v1.0.0'),
      refs: {
        'v1.0.1': { type: 'commit', sha: SHA.other },
        v1: { type: 'commit', sha: SHA.v100 },
      },
      tags: {},
    };
    const run = promote(state, { tag: 'v1.0.1', sha: SHA.v101 });
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /v1\.0\.1 resolves to d{40} instead of b{40}/);
    assert.deepStrictEqual(run.mutations, []);
    assert.strictEqual(run.state.refs.v1.sha, SHA.v100);
  });
});

/** The draft step for `v1.0.0`, dispatched on main at `sha`. */
function draft(state, sha) {
  return runStep(step('draft', 'Create the exact tag and draft release'), state, {
    'github.token': 'token',
    'needs.prepare.outputs.tag': 'v1.0.0',
    'needs.prepare.outputs.release-sha': sha
  });
}

/** The draft an earlier run of this workflow created for `v1.0.0` at `SHA.v100`. */
const ownDraft = (fields) => ({
  id: 7,
  tag_name: 'v1.0.0',
  draft: true,
  prerelease: false,
  author: 'github-actions[bot]',
  target_commitish: SHA.v100,
  url: 'https://github.com/owner/action/releases/tag/untagged-earlier',
  body: `Changes up to ${SHA.v100}`,
  ...fields
});

describe('drafting against the releases and refs', () => {
  test('a first dispatch creates the exact tag and a draft at the release commit', () => {
    const run = draft({ releases: [], refs: {}, tags: {} }, SHA.v100);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v100 });
    assert.strictEqual(run.state.releases[0].draft, true);
    assert.strictEqual(run.state.releases[0].target_commitish, SHA.v100);
    assert.match(run.summary, /Draft release: https:\/\/github\.com\/owner\/action\/releases\/tag\/untagged-new/);
  });

  test('a rerun after main moved moves its own draft and tag to the new commit', () => {
    const state = {
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {}
    };
    const run = draft(state, SHA.v101);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v101 });
    const [release] = run.state.releases;
    assert.strictEqual(release.draft, true);
    assert.strictEqual(release.tag_name, 'v1.0.0');
    assert.strictEqual(release.target_commitish, SHA.v101);
    assert.strictEqual(release.body, `Changes up to ${SHA.v101}`, 'the notes end at the moved tag');
    const endpoint = (call) =>
      call
        .find((arg) => arg.startsWith('repos/'))
        .split('/')
        .slice(3)
        .join('/');
    assert.deepStrictEqual(run.mutations.map(endpoint), ['git/refs/tags/v1.0.0', 'releases/7']);
    assert.ok(run.mutations[0].includes('force=true'));
    const order = run.calls.map((c) => (c[0] === 'api' ? endpoint(c) : c.slice(0, 2).join(' ')));
    assert.ok(
      order.indexOf('git/refs/tags/v1.0.0') < order.indexOf('releases/generate-notes'),
      'the notes are generated after the tag moved'
    );
    assert.match(run.summary, /found the draft an earlier run created/);
    assert.match(run.summary, /untagged-earlier/);
  });

  test('a rerun on the same commit changes nothing', () => {
    const state = {
      releases: [ownDraft({ target_commitish: SHA.v101, body: `Changes up to ${SHA.v101}` })],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v101 } },
      tags: {}
    };
    const run = draft(state, SHA.v101);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.mutations, []);
    assert.deepStrictEqual(run.state, state);
    assert.match(run.summary, /found the draft an earlier run created/);
  });

  test('a rerun after a run that moved the tag but not the draft moves the draft', () => {
    const state = {
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v101 } },
      tags: {}
    };
    const run = draft(state, SHA.v101);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.state.releases[0].target_commitish, SHA.v101);
    assert.strictEqual(run.state.releases[0].body, `Changes up to ${SHA.v101}`);
    assert.deepStrictEqual(
      run.mutations.map((c) => c.find((arg) => arg.startsWith('repos/'))),
      ['repos/owner/action/releases/7'],
      'the tag is already current, so only the draft changes'
    );
  });

  test('a rerun after a run that stopped before the notes updates the notes', () => {
    // The draft already targets the new commit; only the notes still end at the old tag.
    const state = {
      releases: [ownDraft({ target_commitish: SHA.v101 })],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v101 } },
      tags: {}
    };
    const run = draft(state, SHA.v101);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.state.releases[0].body, `Changes up to ${SHA.v101}`);
    assert.strictEqual(run.mutations.length, 1);
  });

  test('a rerun after the notes failed past the tag move updates the notes', () => {
    // The draft already targets the new commit, and its tag still points to the old one.
    const state = {
      releases: [ownDraft({ target_commitish: SHA.v101 })],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
      notesDown: true,
    };
    const failed = draft(state, SHA.v101);
    assert.notStrictEqual(failed.status, 0);
    assert.deepStrictEqual(failed.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v101 });
    assert.strictEqual(failed.state.releases[0].body, `Changes up to ${SHA.v100}`);

    const rerun = draft({ ...failed.state, notesDown: false }, SHA.v101);
    assert.strictEqual(rerun.status, 0, rerun.stderr);
    assert.strictEqual(rerun.state.releases[0].body, `Changes up to ${SHA.v101}`);
    assert.deepStrictEqual(
      rerun.mutations.map((c) => c.find((arg) => arg.startsWith('repos/'))),
      ['repos/owner/action/releases/7'],
      'the tag is already current, so only the notes change'
    );
  });

  test('a draft whose tag is missing gets the tag at the new commit, then moves', () => {
    const run = draft({ releases: [ownDraft()], refs: {}, tags: {} }, SHA.v101);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v101 });
    assert.strictEqual(run.state.releases[0].target_commitish, SHA.v101);
    assert.strictEqual(run.state.releases[0].body, `Changes up to ${SHA.v101}`);
  });

  /** A refused run writes nothing and leaves the tag and the release as they were. */
  const refused = (state, pattern) => {
    const run = draft(state, SHA.v101);
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, pattern);
    assert.deepStrictEqual(run.mutations, []);
    assert.deepStrictEqual(run.state, state);
  };

  test('a published release keeps its tag', () => {
    const release = ownDraft({
      draft: false,
      url: 'https://github.com/owner/action/releases/tag/v1.0.0'
    });
    refused(
      { releases: [release], refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } }, tags: {} },
      /Release v1\.0\.0 already exists and is published/
    );
  });

  test('a draft someone else created keeps its tag and its target', () => {
    const state = {
      releases: [ownDraft({ author: 'maintainer' })],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {}
    };
    refused(state, /belongs to maintainer\.\nRefusing to retarget a draft that this workflow did not create/);
    refused({ ...state, refs: {} }, /belongs to maintainer/);
  });

  test('a tag with no draft stays where it is', () => {
    refused(
      { releases: [], refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } }, tags: {} },
      /Tag v1\.0\.0 already points to a{40} instead of b{40}\.\nNo draft release of this workflow owns it/
    );
  });

  test('a tag that is not a lightweight tag of a commit stays where it is', () => {
    refused(
      {
        releases: [ownDraft()],
        refs: { 'v1.0.0': { type: 'tag', sha: ANNOTATED } },
        tags: { [ANNOTATED]: { type: 'commit', sha: SHA.v100 } }
      },
      /Tag v1\.0\.0 points to a tag object instead of a commit/
    );
    refused(
      { releases: [ownDraft()], refs: { 'v1.0.0': { type: 'tree', sha: SHA.other } }, tags: {} },
      /points to a tree object instead of a commit/
    );
  });

  test('a draft published or replaced while its tag moves stops the run and gets its tag back', () => {
    const state = (onTagMove) => ({
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
      onTagMove,
    });

    const published = draft(state('publish'), SHA.v101);
    assert.notStrictEqual(published.status, 0);
    assert.match(published.stderr, /Release v1\.0\.0 stopped being the draft this run checked/);
    assert.strictEqual(published.state.releases[0].target_commitish, SHA.v100);

    const replaced = draft(state('replace'), SHA.v101);
    assert.notStrictEqual(replaced.status, 0);
    assert.match(replaced.stderr, /stopped being the draft this run checked/);
    assert.deepStrictEqual(replaced.state.releases[0], {
      ...ownDraft(),
      id: 99,
      author: 'maintainer',
    });
    for (const run of [published, replaced]) {
      assert.match(run.stderr, /Tag v1\.0\.0 is back at a{40}\./);
      assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v100 });
      assert.strictEqual(run.mutations.length, 2, 'the tag moved and moved back, nothing else');
    }
  });

  test('a tag someone else moved while the run moved it stays where they put it', () => {
    const state = {
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
      onTagMove: 'retag',
      retagTo: SHA.other,
    };
    const run = draft(state, SHA.v101);
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /Tag v1\.0\.0 now points to d{40}, so this run leaves it there/);
    assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.other });
    assert.strictEqual(run.mutations.length, 1, 'only the first move');
  });

  test('a tag move whose response was lost is read back', () => {
    const state = (fields) => ({
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
      lostResponse: true,
      ...fields,
    });

    const moved = draft(state(), SHA.v101);
    assert.strictEqual(moved.status, 0, moved.stderr);
    assert.deepStrictEqual(moved.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v101 });
    assert.strictEqual(moved.state.releases[0].target_commitish, SHA.v101);
    assert.strictEqual(moved.state.releases[0].body, `Changes up to ${SHA.v101}`);

    const published = draft(state({ onTagMove: 'publish' }), SHA.v101);
    assert.notStrictEqual(published.status, 0);
    assert.match(published.stderr, /Tag v1\.0\.0 is back at a{40}\./);
    assert.deepStrictEqual(published.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v100 });
  });

  test('with immutable releases, a draft published before its tag moves keeps its tag', () => {
    const state = {
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
      immutable: true,
      onView: 'publish',
    };
    const run = draft(state, SHA.v101);
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /Cannot update a tag of an immutable release/);
    assert.match(run.stderr, /Tag v1\.0\.0 stays at a{40}\./);
    assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v100 });
    assert.deepStrictEqual(run.state.releases[0], ownDraft({ draft: false }));
  });

  test('with immutable releases, a draft published right after its tag moved keeps that tag', () => {
    const state = {
      releases: [ownDraft()],
      refs: { 'v1.0.0': { type: 'commit', sha: SHA.v100 } },
      tags: {},
      immutable: true,
      onTagMove: 'publish',
    };
    const run = draft(state, SHA.v101);
    assert.notStrictEqual(run.status, 0);
    assert.match(run.stderr, /Tag v1\.0\.0 could not move back to a{40}\. Check which commit/);
    assert.deepStrictEqual(run.state.refs['v1.0.0'], { type: 'commit', sha: SHA.v101 });
    assert.deepStrictEqual(run.state.releases[0], ownDraft({ draft: false }));
  });
});
