/**
 * Tests for the tea-test-review action.
 *
 * The groups that matter most:
 *
 *   - "buildCliArgs" and "action.yml defaults", because this action is a wrapper
 *     and a wrapper's whole job is to state every input the review branches on. A
 *     duplicated default that drifts from action.yml, or a TEA config key that
 *     silently stops being passed, changes what the agent reviews against without
 *     changing anything visible.
 *   - "buildCommentBody", because the inlined report is the feature: the comment
 *     exists so a reviewer can paste it into a coding agent, and the oversize
 *     fallback is the one path that silently drops it.
 *   - "verdict handling", because a skip, a pass, a waiver and a broken gate must
 *     never read alike.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const action = require('../main.js');

const ACTION_YML = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

/** Declared default for an input in action.yml, so a test can pin a duplicate against it. */
function declaredDefault(inputName) {
  const block = new RegExp(`^  ${inputName}:\\n([\\s\\S]*?)(?=^  \\S|^outputs:)`, 'm').exec(ACTION_YML);
  assert.ok(block, `action.yml has no input named ${inputName}`);
  const match = /^    default: '(.*)'$/m.exec(block[1]);
  return match ? match[1] : null;
}

describe('getInput', () => {
  test('uppercases the name and preserves dashes, matching @actions/core', () => {
    const env = { 'INPUT_MIN-SCORE': ' 80 ', INPUT_AGENT: 'claude' };
    assert.strictEqual(action.getInput('min-score', env), '80');
    assert.strictEqual(action.getInput('agent', env), 'claude');
  });

  test('an absent input is empty rather than undefined', () => {
    assert.strictEqual(action.getInput('nothing', {}), '');
  });
});

describe('getBooleanInput', () => {
  for (const raw of ['true', 'TRUE', '1', 'yes']) {
    test(`${raw} is true`, () => {
      assert.strictEqual(action.getBooleanInput('comment', { INPUT_COMMENT: raw }), true);
    });
  }
  for (const raw of ['false', '0', 'no']) {
    test(`${raw} is false`, () => {
      assert.strictEqual(action.getBooleanInput('comment', { INPUT_COMMENT: raw }), false);
    });
  }
  test('rejects a value that is neither', () => {
    assert.throws(() => action.getBooleanInput('comment', { INPUT_COMMENT: 'maybe' }), /must be a boolean/);
  });
});

describe('binaryName', () => {
  test('npm-installed bins are .cmd shims on Windows', () => {
    assert.strictEqual(action.binaryName('npm', 'win32'), 'npm.cmd');
    assert.strictEqual(action.binaryName('tea-test-review', 'win32'), 'tea-test-review.cmd');
  });
  test('unchanged elsewhere', () => {
    assert.strictEqual(action.binaryName('npm', 'linux'), 'npm');
    assert.strictEqual(action.binaryName('npm', 'darwin'), 'npm');
  });
});

describe('resolveBaseRef', () => {
  test('an explicit value wins', () => {
    assert.strictEqual(action.resolveBaseRef('origin/release', { GITHUB_BASE_REF: 'main' }), 'origin/release');
  });

  test('derives from the event, so a PR into a release branch diffs against that branch', () => {
    // Defaulting to origin/main here would review files the PR never touched.
    assert.strictEqual(action.resolveBaseRef('', { GITHUB_BASE_REF: 'release/2.0' }), 'origin/release/2.0');
  });

  test('falls back to origin/main off a pull request', () => {
    assert.strictEqual(action.resolveBaseRef('', {}), 'origin/main');
    assert.strictEqual(action.resolveBaseRef(undefined, { GITHUB_BASE_REF: '' }), 'origin/main');
  });
});

describe('resolveRunBaseRef', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const err = (status) => ({ ok: false, status, json: async () => null, text: async () => 'boom' });
  const opts = { baseRef: 'origin/main', token: 't', apiUrl: 'https://api.github.com' };

  test('a base ref stated by the caller or the event never touches the API', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ok({});
    };
    const payload = { issue: { number: 7 } };
    assert.strictEqual(await action.resolveRunBaseRef(opts, payload, { GITHUB_BASE_REF: 'release/2.0' }), 'origin/main');
    assert.strictEqual(await action.resolveRunBaseRef(opts, payload, { 'INPUT_BASE-REF': 'origin/9.x' }), 'origin/main');
    assert.strictEqual(calls, 0);
  });

  test('no pull request in context keeps the origin/main guess, so push runs are unchanged', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ok({});
    };
    assert.strictEqual(await action.resolveRunBaseRef(opts, null, {}), 'origin/main');
    assert.strictEqual(calls, 0);
  });

  test('an issue_comment run resolves the PR base through the pulls API', async () => {
    let seen;
    global.fetch = async (url) => {
      seen = url;
      return ok({ base: { ref: 'release/2.0' } });
    };
    const resolved = await action.resolveRunBaseRef(opts, { issue: { number: 7 } }, { GITHUB_REPOSITORY: 'o/r' });
    assert.strictEqual(resolved, 'origin/release/2.0');
    assert.strictEqual(seen, 'https://api.github.com/repos/o/r/pulls/7');
  });

  test('an API failure fails loudly instead of diffing against the wrong base', async () => {
    global.fetch = async () => err(404);
    await assert.rejects(
      action.resolveRunBaseRef(opts, { issue: { number: 7 } }, { GITHUB_REPOSITORY: 'o/r' }),
      /Pass base-ref explicitly/
    );
  });

  test('a missing token fails loudly for the same reason', async () => {
    await assert.rejects(
      action.resolveRunBaseRef({ ...opts, token: '' }, { issue: { number: 7 } }, { GITHUB_REPOSITORY: 'o/r' }),
      /Pass base-ref explicitly/
    );
  });

  test('a response without a base ref fails loudly', async () => {
    global.fetch = async () => ok({});
    await assert.rejects(
      action.resolveRunBaseRef(opts, { issue: { number: 7 } }, { GITHUB_REPOSITORY: 'o/r' }),
      /no base ref/
    );
  });
});

describe('parseMode and parseMentions', () => {
  test('mode defaults to auto and rejects anything else', () => {
    assert.strictEqual(action.parseMode(''), 'auto');
    assert.strictEqual(action.parseMode(undefined), 'auto');
    assert.strictEqual(action.parseMode('manual'), 'manual');
    assert.throws(() => action.parseMode('sometimes'), /mode must be auto or manual/);
  });

  test('mentions split on whitespace and drop empties', () => {
    assert.deepStrictEqual(action.parseMentions('@claude @codex'), ['@claude', '@codex']);
    assert.deepStrictEqual(action.parseMentions('  @tea   review  '), ['@tea', 'review']);
    assert.deepStrictEqual(action.parseMentions(''), []);
  });
});

describe('mention matching, focus, and agent selection', () => {
  test('the first configured mention in the comment wins', () => {
    assert.strictEqual(action.matchMention('please @codex this one', ['@claude', '@codex']), '@codex');
    assert.strictEqual(action.matchMention('@claude and @codex', ['@claude', '@codex']), '@claude');
    assert.strictEqual(action.matchMention('nothing here', ['@claude']), null);
  });

  test('matching is word-delimited and case-sensitive: @claude-alt and @Claude do not fire @claude', () => {
    assert.strictEqual(action.matchMention('@claude-alt look', ['@claude']), null);
    assert.strictEqual(action.matchMention('@Claude look', ['@claude']), null);
    assert.strictEqual(action.matchMention('@claude, look', ['@claude']), '@claude');
    assert.strictEqual(action.matchMention('@claude', ['@claude']), '@claude');
    // Leading boundary too: a mention embedded directly after a word character
    // (an email local part, a username) is not a trigger.
    assert.strictEqual(action.matchMention('team@claude look', ['@claude']), null);
    assert.strictEqual(action.matchMention('write to user@claude.com', ['@claude']), null);
    // An occurrence that fails the boundary check does not hide a later valid one.
    assert.strictEqual(action.matchMention('team@claude, then @claude for real', ['@claude']), '@claude');
  });

  test('focus is whatever the requester wrote after the mention', () => {
    assert.strictEqual(action.extractFocus('@codex focus on the retry paths', '@codex'), 'focus on the retry paths');
    assert.strictEqual(action.extractFocus('@codex', '@codex'), '');
    assert.strictEqual(action.extractFocus('hey @claude\n\nlook at auth', '@claude'), 'look at auth');
    // Sliced after the boundary-valid occurrence the matcher accepted, not an
    // earlier embedded one.
    assert.strictEqual(action.extractFocus('team@codex no, @codex do this', '@codex'), 'do this');
  });

  test('focus is capped at MAX_FOCUS_LENGTH, so a giant comment cannot dominate the prompt', () => {
    const focus = action.extractFocus(`@claude ${'x'.repeat(action.MAX_FOCUS_LENGTH + 500)}`, '@claude');
    assert.strictEqual(focus.length, action.MAX_FOCUS_LENGTH);
  });

  test('a mention naming a built-in vendor selects it; anything else keeps the input', () => {
    assert.strictEqual(action.agentForMention('@claude'), 'claude');
    assert.strictEqual(action.agentForMention('@codex'), 'codex');
    assert.strictEqual(action.agentForMention('@tea'), null);
  });
});

describe('resolveTrigger', () => {
  const mentions = ['@claude', '@codex'];
  const commentOnPr = (body, association = 'MEMBER', userType = 'User') => ({
    issue: { number: 7, pull_request: {} },
    comment: { body, author_association: association, user: { type: userType } },
  });

  test('pull_request runs in auto with the configured agent and no focus', () => {
    const t = action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'codex', payload: {}, eventName: 'pull_request' });
    assert.deepStrictEqual(t, { proceed: true, via: 'pull_request', agent: 'codex', agentSwitched: false, focus: '' });
  });

  test('pull_request skips in manual: the mention is the only way in', () => {
    const t = action.resolveTrigger({ mode: 'manual', mentions, agentInput: 'claude', payload: {}, eventName: 'pull_request' });
    assert.strictEqual(t.proceed, false);
    assert.match(t.reason, /manual/);
  });

  test('manual with an empty prompt is a config error, not a silent never-run', () => {
    assert.throws(
      () => action.resolveTrigger({ mode: 'manual', mentions: [], agentInput: 'claude', payload: {}, eventName: 'pull_request' }),
      /prompt is empty/
    );
  });

  test('issue_comment skips when no mentions are configured', () => {
    const t = action.resolveTrigger({ mode: 'auto', mentions: [], agentInput: 'claude', payload: commentOnPr('@claude'), eventName: 'issue_comment' });
    assert.strictEqual(t.proceed, false);
  });

  test('issue_comment skips on a plain issue, a bot comment, and a mention-less comment', () => {
    assert.strictEqual(
      action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: { issue: { number: 7 }, comment: { body: '@claude' } }, eventName: 'issue_comment' }).proceed,
      false
    );
    assert.strictEqual(
      action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: commentOnPr('@claude', 'MEMBER', 'Bot'), eventName: 'issue_comment' }).proceed,
      false
    );
    assert.strictEqual(
      action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: commentOnPr('lgtm'), eventName: 'issue_comment' }).proceed,
      false
    );
  });

  test('a mention from an untrusted association skips: the gate is the security model', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) {
      const t = action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: commentOnPr('@claude', association), eventName: 'issue_comment' });
      assert.strictEqual(t.proceed, false, association);
      assert.match(t.reason, /association/, association);
    }
    for (const association of action.MENTION_TRUSTED_ASSOCIATIONS) {
      assert.strictEqual(
        action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: commentOnPr('@claude', association), eventName: 'issue_comment' }).proceed,
        true,
        association
      );
    }
  });

  test('a @codex mention switches the agent and carries the focus text', () => {
    const t = action.resolveTrigger({
      mode: 'auto',
      mentions,
      agentInput: 'claude',
      payload: commentOnPr('@codex focus on the retry paths'),
      eventName: 'issue_comment',
    });
    assert.deepStrictEqual(t, {
      proceed: true,
      via: 'mention',
      agent: 'codex',
      agentSwitched: true,
      focus: 'focus on the retry paths',
      mention: '@codex',
    });
  });

  test('a mention naming no built-in vendor keeps the configured agent', () => {
    const t = action.resolveTrigger({
      mode: 'auto',
      mentions: ['@tea'],
      agentInput: 'codex',
      payload: commentOnPr('@tea please'),
      eventName: 'issue_comment',
    });
    assert.strictEqual(t.proceed, true);
    assert.strictEqual(t.agent, 'codex');
    assert.strictEqual(t.agentSwitched, false);
  });

  test('push and dispatch events keep the historical behavior: auto runs, manual skips', () => {
    assert.strictEqual(
      action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: null, eventName: 'push' }).proceed,
      true
    );
    assert.strictEqual(
      action.resolveTrigger({ mode: 'manual', mentions, agentInput: 'claude', payload: null, eventName: 'push' }).proceed,
      false
    );
  });
});

describe('buildOptions trigger overrides', () => {
  const baseEnv = { INPUT_AGENT: 'claude', 'INPUT_ANTHROPIC-API-KEY': 'sk-test' };

  test('an agent override wins over the agent input', () => {
    const opts = action.buildOptions({ ...baseEnv, 'INPUT_OPENAI-API-KEY': 'sk-oai' }, { agentOverride: 'codex' });
    assert.strictEqual(opts.agent.key, 'codex');
  });

  test('a @codex mention switches the resolved agent, the same value the artifact name and comment tag read', () => {
    const trigger = action.resolveTrigger({
      mode: 'auto',
      mentions: ['@claude', '@codex'],
      agentInput: 'claude',
      payload: {
        issue: { number: 7, pull_request: {} },
        comment: { body: '@codex focus on the retry paths', author_association: 'MEMBER', user: { type: 'User' } },
      },
      eventName: 'issue_comment',
    });
    const opts = action.buildOptions(
      { ...baseEnv, 'INPUT_OPENAI-API-KEY': 'sk-oai' },
      { agentOverride: trigger.agent, agentSwitched: trigger.agentSwitched, focus: trigger.focus }
    );
    assert.strictEqual(opts.agent.key, 'codex');
  });

  test('a vendor switch resets the per-vendor knobs, because they would not parse on the new agent', () => {
    const opts = action.buildOptions(
      { ...baseEnv, 'INPUT_OPENAI-API-KEY': 'sk-oai', INPUT_MODEL: 'claude-sonnet-4-6', 'INPUT_AGENT-ARGS': '--verbose' },
      { agentOverride: 'codex', agentSwitched: true }
    );
    assert.strictEqual(opts.cli.model, '');
    assert.deepStrictEqual(opts.cli.agentArgs, []);
  });

  test('without a switch the configured model and agent-args stand', () => {
    const opts = action.buildOptions({ ...baseEnv, INPUT_MODEL: 'claude-sonnet-4-6' }, { agentOverride: 'claude', agentSwitched: false });
    assert.strictEqual(opts.cli.model, 'claude-sonnet-4-6');
  });

  test('focus travels into the CLI args as --focus', () => {
    const opts = action.buildOptions(baseEnv, { focus: 'look at auth' });
    assert.strictEqual(opts.cli.focus, 'look at auth');
    const args = action.buildCliArgs({
      ...opts.cli,
      baseRef: 'origin/main',
      skillRoot: '/tmp/skill',
      reportPath: 'r.md',
      jsonPath: 'r.json',
      cliAgent: 'claude',
      agentCommand: 'claude',
      envPass: '',
    });
    const index = args.indexOf('--focus');
    assert.ok(index !== -1 && args[index + 1] === 'look at auth', args.join(' '));
  });
});

describe('parseTriState', () => {
  test("empty means 'let the CLI resolve it', which is not false", () => {
    // false forces --no-use-pactjs-utils; null passes nothing and lets
    // config.yaml and the module default apply. Collapsing them would override a
    // committed config.yaml on every run.
    assert.strictEqual(action.parseTriState('', 'use-pactjs-utils'), null);
    assert.strictEqual(action.parseTriState(undefined, 'use-pactjs-utils'), null);
  });

  for (const raw of ['true', 'TRUE', '1', 'yes']) {
    test(`${raw} is true`, () => assert.strictEqual(action.parseTriState(raw, 'x'), true));
  }
  for (const raw of ['false', '0', 'no']) {
    test(`${raw} is false`, () => assert.strictEqual(action.parseTriState(raw, 'x'), false));
  }
  test('rejects anything else instead of quietly resolving', () => {
    assert.throws(() => action.parseTriState('on', 'use-pactjs-utils'), /must be 'true', 'false' or empty/);
  });
});

describe('parsePactMcp', () => {
  test('accepts the enum and empty', () => {
    assert.strictEqual(action.parsePactMcp('mcp'), 'mcp');
    assert.strictEqual(action.parsePactMcp('none'), 'none');
    assert.strictEqual(action.parsePactMcp(''), null);
  });
  test('rejects a value outside the enum, which the CLI would exit 2 on anyway', () => {
    assert.throws(() => action.parsePactMcp('server'), /must be 'mcp', 'none' or empty/);
  });
});

describe('parseExtraArgs', () => {
  test('empty is no arguments', () => {
    assert.deepStrictEqual(action.parseExtraArgs(''), []);
    assert.deepStrictEqual(action.parseExtraArgs(undefined), []);
  });

  test('splits on whitespace including newlines, so a YAML block scalar works', () => {
    assert.deepStrictEqual(action.parseExtraArgs('--fail-on-skip\n--timeout-ms 600000'), [
      '--fail-on-skip',
      '--timeout-ms',
      '600000',
    ]);
  });

  test('keeps a quoted waiver reason as one argument', () => {
    assert.deepStrictEqual(action.parseExtraArgs('--waive "flaky suite, FP-1234" --waive-until 2026-09-30'), [
      '--waive',
      'flaky suite, FP-1234',
      '--waive-until',
      '2026-09-30',
    ]);
  });

  test('single quotes work too, and quotes can be internal', () => {
    assert.deepStrictEqual(action.parseExtraArgs("--test-glob '/e2e/.*\\.spec\\.ts/'"), [
      '--test-glob',
      '/e2e/.*\\.spec\\.ts/',
    ]);
    assert.deepStrictEqual(action.parseExtraArgs('--waive a" "b'), ['--waive', 'a b']);
  });

  test('an empty quoted string is still an argument', () => {
    assert.deepStrictEqual(action.parseExtraArgs('--waive ""'), ['--waive', '']);
  });

  test('an unterminated quote is an error rather than a silently truncated flag', () => {
    assert.throws(() => action.parseExtraArgs('--waive "no end'), /unterminated double quote/);
    assert.throws(() => action.parseExtraArgs("--waive 'no end"), /unterminated single quote/);
  });

  test('no shell is involved, so metacharacters stay literal', () => {
    // These tokens go into an argv array. If this ever became a shell string the
    // action would hand an input command substitution.
    assert.deepStrictEqual(action.parseExtraArgs('--waive $(id) --waive-until `date`'), [
      '--waive',
      '$(id)',
      '--waive-until',
      '`date`',
    ]);
  });
});

describe('agentLogin', () => {
  test('codex is logged in from the credential, because it ignores OPENAI_API_KEY', () => {
    const agent = action.resolveAgent({ agent: 'codex' });
    assert.deepStrictEqual(
      agent.loginArgv,
      ['login', '--with-api-key'],
      'codex authenticates only from ~/.codex/auth.json, which no runner has'
    );
  });

  test('claude needs no login step, so the field is absent rather than empty', () => {
    const agent = action.resolveAgent({ agent: 'claude' });
    assert.strictEqual(agent.loginArgv, undefined);
  });

  test('a vendor without loginArgv is a no-op that spawns nothing', () => {
    // Would throw ENOENT on a bogus command if it tried to spawn.
    const agent = { command: 'definitely-not-a-real-binary', loginArgv: undefined };
    assert.doesNotThrow(() => action.agentLogin(agent, { name: 'X', value: 'y' }));
  });

  test('a failing login is a broken gate, not a verdict', () => {
    const agent = { command: 'false', loginArgv: [] };
    assert.throws(
      () => action.agentLogin(agent, { name: 'OPENAI_API_KEY', value: 'sk-nope' }),
      /could not accept the OPENAI_API_KEY credential[\s\S]*broken gate/
    );
  });

  test('a missing agent binary names itself rather than surfacing ENOENT', () => {
    const agent = { command: 'definitely-not-a-real-binary', loginArgv: ['login'] };
    assert.throws(
      () => action.agentLogin(agent, { name: 'OPENAI_API_KEY', value: 'sk-nope' }),
      /definitely-not-a-real-binary not found on PATH/
    );
  });
});

describe('resolveAgent', () => {
  test('claude is built in and takes its version from claude-code-version', () => {
    const agent = action.resolveAgent({ agent: 'claude', agentVersions: { claude: 'latest' } });
    assert.strictEqual(agent.key, 'claude');
    assert.strictEqual(agent.cliAgent, 'claude', 'a known vendor is passed straight through as --agent');
    assert.strictEqual(agent.packageSpec, '@anthropic-ai/claude-code@latest');
    assert.strictEqual(agent.command, 'claude');
    assert.strictEqual(agent.verified, true);
    // Both claude variables are already in the CLI's BASE_ENV_NAMES.
    assert.strictEqual(agent.needsEnvPass, false);
    assert.deepStrictEqual(agent.credentialEnvNames, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  test('codex is built in and takes its version from codex-version', () => {
    // Second built-in vendor, proven live against a real test file by the
    // review CLI's own cli/lib/agent-adapters.js (codex exec --sandbox
    // workspace-write), not just plumbed through --agent-cmd.
    const agent = action.resolveAgent({ agent: 'codex', agentVersions: { codex: 'latest' } });
    assert.strictEqual(agent.key, 'codex');
    assert.strictEqual(agent.cliAgent, 'codex');
    assert.strictEqual(agent.packageSpec, '@openai/codex@latest');
    assert.strictEqual(agent.command, 'codex');
    assert.strictEqual(agent.verified, true);
    // Already covered by the CLI's own codex adapter envNames, same as claude.
    assert.strictEqual(agent.needsEnvPass, false);
    assert.deepStrictEqual(agent.credentialEnvNames, ['OPENAI_API_KEY']);
  });

  test('an empty agent defaults to claude', () => {
    assert.strictEqual(action.resolveAgent({ agent: '', agentVersions: { claude: 'latest' } }).key, 'claude');
    assert.strictEqual(action.resolveAgent({ agentVersions: { claude: 'latest' } }).key, 'claude');
  });

  test('a caller can still pin an exact agent version through the input', () => {
    // The maintained default floats; the ability to pin is what the inputs are for.
    assert.strictEqual(
      action.resolveAgent({ agent: 'claude', agentVersions: { claude: '2.1.220' } }).packageSpec,
      '@anthropic-ai/claude-code@2.1.220'
    );
    assert.strictEqual(
      action.resolveAgent({ agent: 'codex', agentVersions: { codex: '0.146.0' } }).packageSpec,
      '@openai/codex@0.146.0'
    );
  });

  test('an absent agent version composes a spec npm accepts, never one ending in @', () => {
    // buildOptions falls back to `latest`, so this covers a direct caller of
    // resolveAgent: a bare package name resolves to latest on install, while a
    // trailing `@` is not a spec npm can resolve at all.
    for (const key of ['claude', 'codex']) {
      const spec = action.resolveAgent({ agent: key, agentVersions: {} }).packageSpec;
      assert.strictEqual(spec, action.AGENTS[key].package);
      assert.ok(!spec.endsWith('@'), `${spec} would be an unresolvable npm spec`);
    }
  });

  test('agent-package overrides the built-in spec', () => {
    const agent = action.resolveAgent({
      agent: 'claude',
      agentPackage: '@anthropic-ai/claude-code@2.0.0',
      agentVersions: { claude: 'latest' },
    });
    assert.strictEqual(agent.packageSpec, '@anthropic-ai/claude-code@2.0.0');
  });

  test('an unknown vendor works from inputs alone, so a new vendor needs no code change', () => {
    // gemini, not codex: codex is a built-in now, so this needs a genuinely
    // unrecognized vendor to exercise the fallback path.
    const agent = action.resolveAgent({
      agent: 'gemini',
      agentPackage: '@google/gemini-cli@0.5.0',
      agentKeyEnv: 'GEMINI_API_KEY',
    });
    assert.strictEqual(agent.key, 'gemini');
    assert.strictEqual(agent.command, 'gemini', 'the executable defaults to the vendor name');
    assert.strictEqual(agent.packageSpec, '@google/gemini-cli@0.5.0');
    assert.deepStrictEqual(agent.credentialEnvNames, ['GEMINI_API_KEY']);
    // The credential is not in the CLI's BASE_ENV_NAMES, so without --env-pass it
    // is stripped before the agent ever sees it.
    assert.strictEqual(agent.needsEnvPass, true);
    assert.strictEqual(agent.verified, false, 'unproven, and the action warns rather than implying support');
    // Outside the CLI's own adapter table, so it can only run by impersonating
    // claude's protocol through --agent-cmd.
    assert.strictEqual(agent.cliAgent, 'claude');
  });

  test('agent-command overrides the executable independently of the vendor name', () => {
    const agent = action.resolveAgent({
      agent: 'gemini',
      agentPackage: '@google/gemini-cli@0.5.0',
      agentCommand: 'gemini-cli',
      agentKeyEnv: 'GEMINI_API_KEY',
    });
    assert.strictEqual(agent.command, 'gemini-cli');
  });

  test('an unknown vendor without a package is an error, not an install of nothing', () => {
    assert.throws(() => action.resolveAgent({ agent: 'gemini', agentKeyEnv: 'GEMINI_API_KEY' }), /agent-package is required/);
  });

  test('an unknown vendor without a key env is an error, because the credential would be dropped', () => {
    assert.throws(
      () => action.resolveAgent({ agent: 'gemini', agentPackage: '@google/gemini-cli@0.5.0' }),
      /agent-key-env is required/
    );
  });
});

describe('resolveCredential', () => {
  const claude = action.resolveAgent({ agent: 'claude', agentVersions: { claude: 'latest' } });

  test('the api key input wins over the environment', () => {
    const credential = action.resolveCredential({ anthropicApiKey: 'from-input' }, claude, {
      ANTHROPIC_API_KEY: 'from-env',
    });
    assert.deepStrictEqual(credential, { name: 'ANTHROPIC_API_KEY', value: 'from-input' });
  });

  test('the oauth token is an equal alternative, not a fallback', () => {
    const credential = action.resolveCredential({ claudeCodeOauthToken: 'sk-oauth' }, claude, {});
    assert.deepStrictEqual(credential, { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-oauth' });
  });

  test("reads the step's own env when no input was given", () => {
    assert.deepStrictEqual(action.resolveCredential({}, claude, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-oauth' }), {
      name: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'sk-oauth',
    });
  });

  test('a missing credential throws and names the fork case', () => {
    // A required check that passes when it could not run protects nothing, and
    // an empty secret on a fork PR is the way this happens in practice.
    assert.throws(() => action.resolveCredential({}, claude, {}), /no credential for the claude agent/);
    assert.throws(() => action.resolveCredential({}, claude, {}), /Fork pull requests receive no secrets/);
  });

  test('codex resolves its own dedicated input, not the generic custom-vendor one', () => {
    const codex = action.resolveAgent({ agent: 'codex', agentVersions: { codex: 'latest' } });
    assert.deepStrictEqual(action.resolveCredential({ openaiApiKey: 'sk-codex' }, codex, {}), {
      name: 'OPENAI_API_KEY',
      value: 'sk-codex',
    });
    // The claude inputs must not leak into a different vendor's run.
    assert.throws(() => action.resolveCredential({ anthropicApiKey: 'sk-ant' }, codex, {}), /no credential for the codex agent/);
  });

  test('a custom vendor uses its own variable name', () => {
    const gemini = action.resolveAgent({
      agent: 'gemini',
      agentPackage: '@google/gemini-cli@0.5.0',
      agentKeyEnv: 'GEMINI_API_KEY',
    });
    assert.deepStrictEqual(action.resolveCredential({ agentApiKey: 'sk-gemini' }, gemini, {}), {
      name: 'GEMINI_API_KEY',
      value: 'sk-gemini',
    });
    // The claude inputs must not leak into a different vendor's run.
    assert.throws(() => action.resolveCredential({ anthropicApiKey: 'sk-ant' }, gemini, {}), /no credential for the gemini agent/);
  });
});

describe('childEnv', () => {
  const userInfo = { homedir: '/home/runner', username: 'runner' };

  test('USER, LOGNAME and HOME are filled in when the runner leaves them unset', () => {
    // Load-bearing, not cosmetic: the CLI narrows the environment again before
    // spawning the agent, and without USER the claude CLI cannot read its stored
    // credentials and reports "Not logged in", failing every run.
    const env = action.childEnv(null, { PATH: '/usr/bin' }, userInfo);
    assert.strictEqual(env.HOME, '/home/runner');
    assert.strictEqual(env.USER, 'runner');
    assert.strictEqual(env.LOGNAME, 'runner');
  });

  test('existing values are left alone', () => {
    const env = action.childEnv(null, { HOME: '/root', USER: 'ci', LOGNAME: 'ci-log' }, userInfo);
    assert.strictEqual(env.HOME, '/root');
    assert.strictEqual(env.USER, 'ci');
    assert.strictEqual(env.LOGNAME, 'ci-log');
  });

  test('LOGNAME travels with a supplied USER', () => {
    assert.strictEqual(action.childEnv(null, { USER: 'ci' }, userInfo).LOGNAME, 'ci');
  });

  test('injects the credential without mutating the source environment', () => {
    const source = { PATH: '/usr/bin' };
    const env = action.childEnv({ name: 'ANTHROPIC_API_KEY', value: 'sk-test' }, source, userInfo);
    assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-test');
    assert.strictEqual(source.ANTHROPIC_API_KEY, undefined);
  });
});

describe('buildCliArgs', () => {
  const base = {
    baseRef: 'origin/main',
    skillRoot: '/tmp/skill',
    reportPath: 'test-review.md',
    jsonPath: 'test-review.json',
    cliAgent: 'claude',
    agentCommand: 'claude',
  };

  test('the mandatory shape: pinned skill root, both output files, claude executor', () => {
    assert.deepStrictEqual(action.buildCliArgs(base), [
      '--base',
      'origin/main',
      '--agent',
      'claude',
      '--skill-root',
      '/tmp/skill',
      '--output',
      'test-review.md',
      '--json',
      'test-review.json',
    ]);
  });

  test('--skill-root is always passed, so the PR checkout is never probed for the reviewer', () => {
    // Without it the CLI probes the project, and a PR that edits its own vendored
    // _bmad/ copy would be rewriting the reviewer that judges it.
    const args = action.buildCliArgs(base);
    assert.ok(args.includes('--skill-root'));
    assert.strictEqual(args[args.indexOf('--skill-root') + 1], '/tmp/skill');
  });

  test('--json is always passed, because the verdict and the comment both come from it', () => {
    assert.ok(action.buildCliArgs(base).includes('--json'));
  });

  test('empty gate-policy inputs are omitted rather than sent as empty flags', () => {
    const args = action.buildCliArgs({
      ...base,
      testDir: '',
      scope: '',
      minScore: '',
      maxCritical: '',
      minFiles: '',
      failOn: '',
      gateOn: '',
    });
    for (const flag of ['--test-dir', '--scope', '--min-score', '--max-critical', '--min-files', '--fail-on', '--gate-on']) {
      assert.ok(!args.includes(flag), `${flag} should be absent`);
    }
  });

  test('gate policy passes through', () => {
    const args = action.buildCliArgs({
      ...base,
      minScore: '80',
      maxCritical: '0',
      minFiles: '2',
      failOn: 'block',
      gateOn: 'introduced',
      testDir: 'test',
      scope: 'directory',
    });
    for (const [flag, value] of [
      ['--min-score', '80'],
      ['--max-critical', '0'],
      ['--min-files', '2'],
      ['--fail-on', 'block'],
      ['--gate-on', 'introduced'],
      ['--test-dir', 'test'],
      ['--scope', 'directory'],
    ]) {
      assert.strictEqual(args[args.indexOf(flag) + 1], value, flag);
    }
  });

  test("max-critical '0' survives, because a zero cap is the strictest setting and the falsiest string", () => {
    assert.ok(action.buildCliArgs({ ...base, maxCritical: '0' }).includes('--max-critical'));
  });

  test('the three TEA config keys become explicit flags in both directions', () => {
    // An unstated key is one the agent settles per run, so identical files can be
    // reviewed against different knowledge. This is why they are modelled at all.
    const on = action.buildCliArgs({ ...base, usePlaywrightUtils: true, usePactjsUtils: true, pactMcp: 'mcp' });
    assert.ok(on.includes('--use-playwright-utils'));
    assert.ok(on.includes('--use-pactjs-utils'));
    assert.strictEqual(on[on.indexOf('--pact-mcp') + 1], 'mcp');

    const off = action.buildCliArgs({ ...base, usePlaywrightUtils: false, usePactjsUtils: false, pactMcp: 'none' });
    assert.ok(off.includes('--no-use-playwright-utils'));
    assert.ok(off.includes('--no-use-pactjs-utils'));
    assert.strictEqual(off[off.indexOf('--pact-mcp') + 1], 'none');
  });

  test('a null config key passes nothing, leaving config.yaml and the module default in charge', () => {
    const args = action.buildCliArgs({ ...base, usePlaywrightUtils: null, usePactjsUtils: null, pactMcp: null });
    for (const flag of [
      '--use-playwright-utils',
      '--no-use-playwright-utils',
      '--use-pactjs-utils',
      '--no-use-pactjs-utils',
      '--pact-mcp',
    ]) {
      assert.ok(!args.includes(flag), `${flag} should be absent`);
    }
  });

  test('--agent is the resolved cliAgent, not a hardcoded claude', () => {
    const args = action.buildCliArgs({ ...base, cliAgent: 'codex', agentCommand: 'codex' });
    assert.strictEqual(args[args.indexOf('--agent') + 1], 'codex');
  });

  test('--agent-cmd is omitted when the resolved command already matches --agent', () => {
    // True for both built-ins with no agent-command override: claude (base)
    // and codex, since resolveAgent defaults command to the vendor's own name.
    assert.ok(!action.buildCliArgs(base).includes('--agent-cmd'));
    assert.ok(!action.buildCliArgs({ ...base, cliAgent: 'codex', agentCommand: 'codex' }).includes('--agent-cmd'));
  });

  test('--agent-cmd overrides the executable on top of whichever --agent adapter was selected', () => {
    // A codex-version override, or any executable that differs from cliAgent.
    const overridden = action.buildCliArgs({ ...base, cliAgent: 'codex', agentCommand: 'codex-beta' });
    assert.strictEqual(overridden[overridden.indexOf('--agent-cmd') + 1], 'codex-beta');
    assert.strictEqual(overridden[overridden.indexOf('--agent') + 1], 'codex');

    // A custom vendor impersonates claude's protocol (cliAgent stays 'claude'),
    // so its own binary name always differs from cliAgent and always needs
    // --agent-cmd.
    const custom = action.buildCliArgs({ ...base, cliAgent: 'claude', agentCommand: 'gemini' });
    assert.strictEqual(custom[custom.indexOf('--agent-cmd') + 1], 'gemini');
    assert.strictEqual(custom[custom.indexOf('--agent') + 1], 'claude');
  });

  test('model passes through when set', () => {
    const args = action.buildCliArgs({ ...base, model: 'opus[1m]' });
    assert.strictEqual(args[args.indexOf('--model') + 1], 'opus[1m]');
  });

  test('agent-args keep their order and use equals form for flag-shaped values', () => {
    const args = action.buildCliArgs({
      ...base,
      agentArgs: ['--add-dir=/tmp', '-c', 'model_reasoning_effort=low'],
    });
    assert.deepStrictEqual(args.slice(-3), [
      '--agent-arg=--add-dir=/tmp',
      '--agent-arg=-c',
      '--agent-arg=model_reasoning_effort=low',
    ]);
  });

  test('an empty model passes nothing, leaving the CLI\'s per-vendor pinned default in charge', () => {
    // Absent means "use the pinned default", never "let the vendor CLI decide":
    // that resolution lives in the CLI's adapter table, not here.
    assert.ok(!action.buildCliArgs({ ...base, model: '' }).includes('--model'));
  });

  test("a custom vendor's credential is allowlisted with --env-pass", () => {
    const args = action.buildCliArgs({ ...base, envPass: 'GEMINI_API_KEY' });
    assert.strictEqual(args[args.indexOf('--env-pass') + 1], 'GEMINI_API_KEY');
  });

  test('extra-args land last, so a caller can override an earlier flag', () => {
    const args = action.buildCliArgs({ ...base, minScore: '80', extraArgs: ['--min-score', '90', '--fail-on-skip'] });
    assert.deepStrictEqual(args.slice(-3), ['--min-score', '90', '--fail-on-skip']);
  });
});

describe('action.yml defaults', () => {
  // main.js repeats four of action.yml's defaults as fallbacks, for the case
  // where the action is invoked with no INPUT_ variables at all. A duplicated
  // default that is not pinned by a test rots: action.yml gets bumped, the
  // fallback does not, and which version installs depends on how it was called.
  const buildWith = (env) =>
    action.buildOptions({ INPUT_AGENT: 'claude', 'INPUT_ANTHROPIC-API-KEY': 'sk-test', ...env });

  test('tea-version', () => {
    assert.strictEqual(buildWith({}).teaVersion, declaredDefault('tea-version'));
  });

  test('claude-code-version floats to latest', () => {
    // The agent CLIs follow tea-version's shape: nobody maintains a pin, and a
    // caller who needs one passes it through the input.
    assert.strictEqual(declaredDefault('claude-code-version'), 'latest');
    assert.strictEqual(buildWith({}).agent.packageSpec, `@anthropic-ai/claude-code@${declaredDefault('claude-code-version')}`);
  });

  test('codex-version floats to latest', () => {
    assert.strictEqual(declaredDefault('codex-version'), 'latest');
    const opts = action.buildOptions({ INPUT_AGENT: 'codex', 'INPUT_OPENAI-API-KEY': 'sk-test' });
    assert.strictEqual(opts.agent.packageSpec, `@openai/codex@${declaredDefault('codex-version')}`);
  });

  test('an empty version input behaves like an absent one', () => {
    // An action called through `with:` sends the input as an empty string when
    // a caller sets it to nothing, which must not compose a spec ending in `@`.
    assert.strictEqual(
      buildWith({ 'INPUT_CLAUDE-CODE-VERSION': '' }).agent.packageSpec,
      '@anthropic-ai/claude-code@latest'
    );
    const codex = action.buildOptions({
      INPUT_AGENT: 'codex',
      'INPUT_OPENAI-API-KEY': 'sk-test',
      'INPUT_CODEX-VERSION': '',
    });
    assert.strictEqual(codex.agent.packageSpec, '@openai/codex@latest');
  });

  test('report-path and json-path', () => {
    const opts = buildWith({});
    assert.strictEqual(opts.reportPath, declaredDefault('report-path'));
    assert.strictEqual(opts.jsonPath, declaredDefault('json-path'));
  });

  test('base-ref is declared empty and derived at runtime', () => {
    assert.strictEqual(declaredDefault('base-ref'), '');
    assert.strictEqual(buildWith({ GITHUB_BASE_REF: 'main' }).baseRef, 'origin/main');
  });

  test('gate-on stays empty by default and passes through when set', () => {
    assert.strictEqual(declaredDefault('gate-on'), '');
    assert.strictEqual(buildWith({}).cli.gateOn, '');
    assert.strictEqual(buildWith({ 'INPUT_GATE-ON': 'all' }).cli.gateOn, 'all');
  });

  test('agent-args are parsed as a shell-style argument list', () => {
    const opts = buildWith({ 'INPUT_AGENT-ARGS': '-c "model_reasoning_effort=low"' });
    assert.deepStrictEqual(opts.cli.agentArgs, ['-c', 'model_reasoning_effort=low']);
  });

  test('check-run defaults to true, so a mention-triggered review is visible without extra wiring', () => {
    // The composite always passes the declared default through, so that is the
    // env a real run sees. An unset variable falls to false, the safe direction,
    // the same way comment and upload-report do.
    assert.strictEqual(declaredDefault('check-run'), 'true');
    assert.strictEqual(buildWith({ 'INPUT_CHECK-RUN': declaredDefault('check-run') }).checkRun, true);
    assert.strictEqual(buildWith({ 'INPUT_CHECK-RUN': 'false' }).checkRun, false);
    assert.strictEqual(buildWith({}).checkRun, false);
  });

  test('check-run-name is fixed by default, because branch protection matches it exactly', () => {
    assert.strictEqual(declaredDefault('check-run-name'), 'TEA Test Review');
    assert.strictEqual(buildWith({}).checkRunName, 'TEA Test Review');
    assert.strictEqual(buildWith({ 'INPUT_CHECK-RUN-NAME': 'tests' }).checkRunName, 'tests');
  });

  test('every run gets its own pull request cache, so nothing leaks between them', () => {
    assert.ok(buildWith({}).prCache instanceof Map);
    assert.notStrictEqual(buildWith({}).prCache, buildWith({}).prCache);
  });

  test('every documented workflow grants the permissions the action writes with', () => {
    // A recipe that is copied verbatim and then fails on a 403 is a broken
    // recipe, and these are the two writes the action makes.
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .filter((b) => /^on:/m.test(b) && /uses: muratkeremozcan\/tea-test-review/.test(b));
    assert.ok(blocks.length >= 3, `expected the proven configurations, saw ${blocks.length}`);
    for (const block of blocks) {
      assert.match(block, /pull-requests: write/);
      assert.match(block, /checks: write/);
    }
  });

  test("the three TEA config keys default to empty, so the CLI's own resolution stands", () => {
    for (const name of ['use-playwright-utils', 'use-pactjs-utils', 'pact-mcp']) {
      assert.strictEqual(declaredDefault(name), '', name);
    }
    const opts = buildWith({});
    assert.strictEqual(opts.cli.usePlaywrightUtils, null);
    assert.strictEqual(opts.cli.usePactjsUtils, null);
    assert.strictEqual(opts.cli.pactMcp, null);
  });

  test('every input main.js reads is declared in action.yml', () => {
    // An input read but not declared is one no caller can set and no `with:` typo
    // check will catch.
    const read = new Set();
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    for (const match of source.matchAll(/get(?:Boolean)?Input\('([^']+)'/g)) read.add(match[1]);
    read.delete('nothing');
    for (const name of read) {
      assert.match(ACTION_YML, new RegExp(`^  ${name}:$`, 'm'), `action.yml is missing input ${name}`);
    }
    assert.ok(read.size >= 34, `expected the full input surface, saw ${read.size}`);
  });

  test('every output main.js sets is declared in action.yml', () => {
    const declared = new Set();
    const outputsSection = ACTION_YML.slice(ACTION_YML.indexOf('\noutputs:'));
    for (const match of outputsSection.matchAll(/^  ([a-z-]+):$/gm)) declared.add(match[1]);
    const set = new Set([...Object.keys(action.outputsFromVerdict({})), 'report-path', 'json-path']);
    for (const name of set) assert.ok(declared.has(name), `action.yml is missing output ${name}`);
  });

  test('comment defaults to true in action.yml, and main.js deliberately does not repeat it', () => {
    // Not duplicated on purpose. GitHub always injects a declared default, so the
    // only caller that reaches the fallback is one invoking main.js directly, and
    // there the safe direction is to write no comment.
    assert.strictEqual(declaredDefault('comment'), 'true');
    assert.strictEqual(buildWith({}).comment, false);
    assert.strictEqual(buildWith({ INPUT_COMMENT: 'true' }).comment, true);
  });

  test('upload-report defaults to true in action.yml, and main.js deliberately does not repeat it', () => {
    // Same reasoning as comment: a direct invocation writes nothing outside the
    // workspace.
    assert.strictEqual(declaredDefault('upload-report'), 'true');
    assert.strictEqual(buildWith({}).uploadReport, false);
    assert.strictEqual(buildWith({ 'INPUT_UPLOAD-REPORT': 'true' }).uploadReport, true);
  });

  test('runs as a composite action, because a JavaScript action cannot have an upload step', () => {
    assert.match(ACTION_YML, /^runs:\n  using: composite$/m);
    assert.match(ACTION_YML, /run: node "\$GITHUB_ACTION_PATH\/main\.js"/);
  });

  test('node is pinned to 24, which the node24 runtime used to guarantee', () => {
    // Composite steps run on the image's node, so without this the runtime
    // moves whenever the runner image does.
    assert.match(ACTION_YML, /uses: actions\/setup-node@v4\n      with:\n        node-version: '24'/);
  });

  test('GitHub-hosted Linux enables the user namespaces Codex bubblewrap needs', () => {
    const setupIndex = ACTION_YML.indexOf('- name: Enable Linux user namespaces for Codex');
    const reviewIndex = ACTION_YML.indexOf('- name: Run the review');
    assert.ok(setupIndex > 0 && setupIndex < reviewIndex, 'sandbox prerequisite must run before the review');
    assert.match(
      ACTION_YML,
      /if: \$\{\{ inputs\.agent == 'codex' && runner\.os == 'Linux' && runner\.environment == 'github-hosted' \}\}/,
    );
    assert.match(ACTION_YML, /sudo sysctl -w kernel\.unprivileged_userns_clone=1/);
    assert.match(ACTION_YML, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
  });

  test('every declared input reaches main.js as an INPUT_ variable', () => {
    // Composite run steps get no automatic INPUT_* env, so an input declared
    // but not mapped is silently always its default.
    const inputsSection = ACTION_YML.slice(ACTION_YML.indexOf('\ninputs:'), ACTION_YML.indexOf('\noutputs:'));
    const declared = [...inputsSection.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
    assert.ok(declared.length >= 34, `expected the full input surface, saw ${declared.length}`);
    for (const name of declared) {
      const envName = `INPUT_${name.toUpperCase()}`;
      assert.match(ACTION_YML, new RegExp(`^        ${envName}: \\$\\{\\{ inputs\\.${name} \\}\\}$`, 'm'), `composite step does not map ${name}`);
    }
  });

  test('every declared output is wired to the review step', () => {
    const outputsSection = ACTION_YML.slice(ACTION_YML.indexOf('\noutputs:'), ACTION_YML.indexOf('\nruns:'));
    const declared = [...outputsSection.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
    assert.ok(declared.length >= 10, `expected the full output surface, saw ${declared.length}`);
    for (const name of declared) {
      assert.match(outputsSection, new RegExp(`value: \\$\\{\\{ steps\\.review\\.outputs\\.${name} \\}\\}`), `output ${name} has no value`);
    }
  });

  test('the report upload runs even on a failing verdict, which is when the report matters most', () => {
    assert.match(ACTION_YML, /if: always\(\) && inputs\.upload-report == 'true'/);
    assert.match(ACTION_YML, /uses: actions\/upload-artifact@v4/);
    // Two invocations in one job (a dry run, then a live review) share the
    // artifact name, and v4 artifacts are immutable without this.
    assert.match(ACTION_YML, /overwrite: true/);
  });

  test('the artifact name in action.yml matches the one main.js promises in the comment', () => {
    // inputs.agent is the unresolved, un-switched configuration value; a
    // mention like @codex only changes opts.agent.key at runtime. The
    // artifact name has to read the resolved value from the review step's
    // own output, the same source publishComment uses, or the two diverge
    // the moment a mention switches the agent.
    assert.match(ACTION_YML, /name: tea-test-review-\$\{\{ github\.job \}\}-\$\{\{ steps\.review\.outputs\.agent \}\}/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(source, /tea-test-review-\$\{env\.GITHUB_JOB\}-\$\{agentKey\}/);
  });
});

describe('packedTarballName', () => {
  test('reads the filename npm pack --json reports', () => {
    const stdout = JSON.stringify([{ filename: 'bmad-method-test-architecture-enterprise-1.19.1.tgz' }]);
    assert.strictEqual(action.packedTarballName(stdout, []), 'bmad-method-test-architecture-enterprise-1.19.1.tgz');
  });

  test('accepts a bare object as well as an array', () => {
    assert.strictEqual(action.packedTarballName(JSON.stringify({ filename: 'pkg-1.0.0.tgz' }), []), 'pkg-1.0.0.tgz');
  });

  test('falls back to the directory when the output is not JSON', () => {
    // The filename is only predictable when the version is an exact number, and
    // tea-version accepts a dist-tag.
    assert.strictEqual(action.packedTarballName('npm notice something', ['pkg-1.19.1.tgz', 'other.txt']), 'pkg-1.19.1.tgz');
  });

  test('no tarball is an error, not an empty extract', () => {
    assert.throws(() => action.packedTarballName('not json', []), /wrote no tarball/);
  });

  test('two tarballs is an error rather than a coin flip on which version installs', () => {
    assert.throws(() => action.packedTarballName('not json', ['a-1.0.0.tgz', 'a-2.0.0.tgz']), /cannot tell which is the pinned one/);
  });
});

describe('assertShipsCli', () => {
  test('accepts a version whose package.json declares the bin', () => {
    action.assertShipsCli({ bin: { 'tea-test-review': 'cli/test-review.js' } }, 'pkg@1.20.0');
    action.assertShipsCli({ bin: 'cli/test-review.js' }, 'pkg@1.20.0');
  });

  const rejected = [
    ['an empty bin map, which is what the published 1.19.1 has', { bin: {} }],
    ['no bin field at all', {}],
    ['a bin map for some other binary', { bin: { 'other-cli': 'x.js' } }],
    ['an unreadable package.json', null],
  ];
  for (const [why, packageJson] of rejected) {
    test(`rejects ${why}`, () => {
      // The alternative failure is "tea-test-review not found on PATH" after two
      // installs, which reads like a runner problem rather than a version that
      // never had the binary.
      assert.throws(() => action.assertShipsCli(packageJson, 'pkg@1.19.1'), /does not ship the tea-test-review CLI/);
      assert.throws(() => action.assertShipsCli(packageJson, 'pkg@1.19.1'), /Set tea-version to the first version that ships it/);
    });
  }
});

describe('outputsFromVerdict', () => {
  const passing = {
    recommendation: 'Approve',
    qualityScore: 92,
    violations: { critical: 0, high: 1, medium: 2, low: 3 },
    rawQualityScore: 97,
    gateOn: 'introduced',
    gatingQualityScore: 96,
    gatingViolations: { critical: 0, high: 0, medium: 1, low: 0 },
    reviewedFiles: ['tests/checkout.spec.ts'],
  };

  test('a passing verdict maps every field', () => {
    assert.deepStrictEqual(action.outputsFromVerdict(passing), {
      recommendation: 'Approve',
      'quality-score': '96',
      'full-quality-score': '92',
      'raw-quality-score': '97',
      'gate-on': 'introduced',
      critical: '0',
      high: '0',
      medium: '1',
      low: '0',
      'reviewed-files': '1',
      skipped: 'false',
    });
  });

  test('a skipped review reports no score and no recommendation', () => {
    // A skip and a pass both exit 0, so `skipped` is the only way a caller can
    // tell them apart. Reporting 0/100 here would read as a catastrophic review.
    const outputs = action.outputsFromVerdict({ skipped: true, recommendation: null, qualityScore: null, files: [] });
    assert.strictEqual(outputs.skipped, 'true');
    assert.strictEqual(outputs.recommendation, '');
    assert.strictEqual(outputs['quality-score'], '');
    assert.strictEqual(outputs['full-quality-score'], '');
    assert.strictEqual(outputs['raw-quality-score'], '');
    assert.strictEqual(outputs['gate-on'], '');
    assert.strictEqual(outputs['reviewed-files'], '0');
  });

  test('a missing verdict yields empty strings and zeros rather than throwing', () => {
    const outputs = action.outputsFromVerdict(null);
    assert.strictEqual(outputs.recommendation, '');
    assert.strictEqual(outputs.critical, '0');
  });

  test('reviewed-files counts the report manifest, which is what --min-files evaluates', () => {
    const outputs = action.outputsFromVerdict({
      ...passing,
      files: ['a', 'b', 'c'],
      reviewedFiles: ['a', 'b'],
    });
    assert.strictEqual(outputs['reviewed-files'], '2');
  });
});

describe('buildCommentBody', () => {
  const runUrl = 'https://github.com/o/r/actions/runs/1';
  const verdict = {
    recommendation: 'Request Changes',
    qualityScore: 64,
    rawQualityScore: 84,
    scoreOverrideRule: 'Highest severity Critical caps effective score at 69.',
    verdictRule: 'High findings require Request Changes.',
    gateOn: 'introduced',
    gatingQualityScore: 79,
    gatingViolations: { critical: 0, high: 2, medium: 1, low: 0 },
    allFindingsRecommendation: 'Block',
    violations: { critical: 1, high: 2, medium: 3, low: 4 },
    reviewedFiles: ['tests/checkout.spec.ts', 'tests/cart.spec.ts'],
    findings: [
      { row: 'H1', title: 'first' },
      { row: 'H2', title: 'second' },
      { row: 'H3', title: 'third' },
      { row: 'H4', title: 'fourth' },
    ],
    keyWeaknesses: ['[H1] free-form first', '[H2] free-form second', '[H3] free-form third', '[H4] free-form fourth'],
    advisoryObservations: ['n/a', 'Consider an optional helper'],
  };

  test('carries the marker, so the next push updates this comment instead of adding one', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.ok(body.startsWith('<!-- tea-test-review:claude -->'));
  });

  test('the digest states score, recommendation, violations and reviewed-file count', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.match(body, /## TEA Test Review \(claude\): Request Changes/);
    assert.match(body, /\*\*Gate mode\*\*: introduced/);
    assert.match(body, /\*\*Gating quality score\*\*: 79\/100/);
    assert.match(body, /\*\*Full-review effective score\*\*: 64\/100/);
    assert.match(body, /\*\*Raw deduction score\*\*: 84\/100/);
    assert.match(body, /\*\*Full-review recommendation\*\*: Block/);
    assert.match(body, /\*\*Gating violations\*\*: 0 Critical \/ 2 High \/ 1 Medium \/ 0 Low/);
    assert.match(body, /\*\*Reviewed files\*\*: 2/);
  });

  test('omits the full-review recommendation when the gate never overrode it', () => {
    const { allFindingsRecommendation, ...verdictWithoutDelta } = verdict;
    const body = action.buildCommentBody({ verdict: verdictWithoutDelta, reportText: '# report', runUrl });
    assert.ok(!body.includes('Full-review recommendation'));
  });

  test('the digest names every reviewed file, so a finding citing a line number is attributable', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.match(body, /- \*\*Reviewed files\*\*: 2\n  - `tests\/checkout\.spec\.ts`\n  - `tests\/cart\.spec\.ts`/);
  });

  test('past the cap the file list collapses to an overflow line, so the digest stays a digest', () => {
    const many = { ...verdict, reviewedFiles: Array.from({ length: 12 }, (_, i) => `tests/f${i}.spec.ts`) };
    const body = action.buildCommentBody({ verdict: many, reportText: '# report', runUrl });
    assert.match(body, /\*\*Reviewed files\*\*: 12/);
    assert.match(body, /`tests\/f9\.spec\.ts`/);
    assert.ok(!body.includes('`tests/f10.spec.ts`'));
    assert.match(body, /… and 2 more/);
  });

  test('a malformed reviewedFiles renders as a count of zero rather than undefined', () => {
    const body = action.buildCommentBody({ verdict: { ...verdict, reviewedFiles: 'oops' }, reportText: '# report', runUrl });
    assert.match(body, /\*\*Reviewed files\*\*: 0/);
    assert.ok(!body.includes('undefined'));
  });

  test('at most three key weaknesses, so the digest stays a digest', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.match(body, /- \[H1\] first/);
    assert.match(body, /- \[H3\] third/);
    assert.ok(!body.includes('- [H4] fourth'));
    assert.ok(!body.includes('free-form'));
  });

  test('advisories are separate and empty or n/a items are hidden', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.match(body, /\*\*Advisory observations\*\*:\n- Consider an optional helper/);
    assert.ok(!body.includes('- n/a'));
  });

  test('the full report is inlined in a collapsed block, which is the reason to comment at all', () => {
    // The point is a reviewer pasting the report into their own coding agent
    // without downloading an artifact.
    const body = action.buildCommentBody({ verdict, reportText: '# Test Review\n\nbody text', runUrl });
    assert.match(body, /<details>/);
    assert.match(body, /<summary>Full report \(paste into your AI coding agent to apply the fixes\)<\/summary>/);
    assert.match(body, /# Test Review/);
    assert.match(body, /<\/details>/);
  });

  test('the digest names the agent and model, so two scores are comparable', () => {
    const body = action.buildCommentBody({
      verdict: { ...verdict, agent: 'codex', model: 'gpt-5.6-luna' },
      reportText: '# report',
      runUrl,
    });
    assert.match(body, /- \*\*Reviewer\*\*: codex \/ gpt-5\.6-luna/);
  });

  test('a verdict with no agent or model omits the reviewer line rather than printing undefined', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.ok(!body.includes('**Reviewer**'));
  });

  test('the inlined report has its frontmatter fenced, so bookkeeping stops rendering as a heading', () => {
    // The closing `---` is a setext underline, so an unfenced block renders the
    // resume state larger than the report title directly beneath it.
    const reportText = "---\nlastStep: 'step-04-generate-report'\nworkflowType: 'testarch-test-review'\n---\n\n# Test Quality Review\n";
    const body = action.buildCommentBody({ verdict, reportText, runUrl });
    assert.match(body, /```yaml\nlastStep: 'step-04-generate-report'\nworkflowType: 'testarch-test-review'\n```/);
    assert.match(body, /# Test Quality Review/);
  });

  test('a report containing a literal closing details tag cannot end the inline block early', () => {
    // The zero-width space breaks it as an HTML tag while leaving the visible
    // text unchanged; without it the rest of the report spills into the comment
    // as raw markdown.
    const body = action.buildCommentBody({ verdict, reportText: '# report\n\n</details>\n\nafter', runUrl });
    assert.strictEqual(body.split('</details>').length - 1, 1);
    assert.ok(body.includes('<\u200B/details>'));
  });

  test('an oversize report points at the uploaded artifact, which survives the runner', () => {
    const reportText = 'x'.repeat(action.MAX_INLINE_REPORT_CHARS + 1);
    const body = action.buildCommentBody({
      verdict,
      reportText,
      runUrl,
      reportPath: 'test-review.md',
      artifactName: 'tea-test-review-review',
    });
    assert.ok(!body.includes('<details>'));
    assert.match(body, /too large to inline \(40001 characters, limit 40000\)/);
    assert.match(body, /uploaded as the `tea-test-review-review` artifact on the workflow run/);
    // GitHub rejects a body over 65536, which would lose the verdict entirely.
    assert.ok(body.length < 65536);
  });

  test('an oversize report with no artifact upload says the workspace copy dies with the job', () => {
    const reportText = 'x'.repeat(action.MAX_INLINE_REPORT_CHARS + 1);
    const body = action.buildCommentBody({ verdict, reportText, runUrl, reportPath: 'test-review.md' });
    assert.match(body, /`test-review\.md`, which the runner deletes when the job ends/);
    assert.match(body, /enable `upload-report` or add an `actions\/upload-artifact` step/);
  });

  test('a report exactly at the cap is still inlined', () => {
    const body = action.buildCommentBody({
      verdict,
      reportText: 'x'.repeat(action.MAX_INLINE_REPORT_CHARS),
      runUrl,
    });
    assert.match(body, /<details>/);
  });

  test('a missing report keeps the digest instead of dropping the comment', () => {
    const body = action.buildCommentBody({ verdict, reportText: null, runUrl, reportPath: 'test-review.md' });
    assert.match(body, /\*\*Gating quality score\*\*: 79\/100/);
    assert.match(body, /not readable from the workspace/);
  });

  test('a skipped review says so, and claims no verdict', () => {
    const body = action.buildCommentBody({
      verdict: { skipped: true, reason: 'no changed test files in diff' },
      runUrl,
    });
    assert.match(body, /## TEA Test Review \(claude\): skipped/);
    assert.match(body, /no changed test files in diff\./);
    assert.ok(!body.includes('Quality score'));
  });

  test('a skip with no reason still reads as a skip', () => {
    const body = action.buildCommentBody({ verdict: { skipped: true }, runUrl });
    assert.match(body, /No changed test files in this PR\./);
  });

  test('a skip says what the PR changed instead, when the context set is known', () => {
    const body = action.buildCommentBody({
      verdict: { skipped: true, reason: 'no changed test files in diff', contextFiles: ['src/a.ts', 'src/b.ts'] },
      runUrl,
    });
    assert.match(body, /no changed test files in diff \(2 other files changed\)\./);
    assert.ok(!body.includes('You asked me to focus on'));
  });

  test('a mention-triggered skip acknowledges the focus, so the requester knows they were heard', () => {
    const body = action.buildCommentBody({
      verdict: { skipped: true, reason: 'no changed test files in diff', contextFiles: ['src/auth/login.ts'] },
      focus: 'what about the retry handling',
      runUrl,
    });
    assert.match(body, /\(1 other file changed\)/);
    assert.match(body, /You asked me to focus on:\n\n> what about the retry handling\n/);
    assert.match(body, /There were no tests in scope to apply that to\./);
  });

  test('a multi-line focus quotes every line', () => {
    const body = action.buildCommentBody({
      verdict: { skipped: true },
      focus: 'look at auth\nand the retries',
      runUrl,
    });
    assert.match(body, /> look at auth\n> and the retries\n/);
  });

  test('an --agent none dry run says no review happened, rather than a verdict of undefined', () => {
    // Reachable through extra-args, and the payload has no recommendation at all.
    const body = action.buildCommentBody({ verdict: { promptOnly: true, files: ['tests/a.spec.ts'] }, runUrl });
    assert.match(body, /## TEA Test Review \(claude\): no review performed/);
    assert.match(body, /Files that would have been reviewed: 1\./);
    assert.ok(!body.includes('undefined'));
  });

  test('a dry run lists the files, because the file set is its whole output', () => {
    const body = action.buildCommentBody({
      verdict: { promptOnly: true, files: ['tests/a.spec.ts', 'tests/b.spec.ts'] },
      runUrl,
    });
    assert.match(body, /Files that would have been reviewed: 2\.\n- `tests\/a\.spec\.ts`\n- `tests\/b\.spec\.ts`/);
  });

  test('no verdict at all reads as a broken gate, never as approved tests', () => {
    // The distinction the whole action turns on: exit 2 and 3 are not verdicts.
    const body = action.buildCommentBody({ verdict: null, runUrl, reviewResult: 'exit 3 (agent failure)' });
    assert.match(body, /## TEA Test Review \(claude\): infrastructure failure/);
    assert.match(body, /\*\*not\*\* a review verdict/);
    assert.match(body, /treat the gate as broken, not as approved tests/);
    assert.match(body, /exit 3 \(agent failure\)/);
  });

  test('a waiver is stated in the comment rather than hidden behind a green step', () => {
    const body = action.buildCommentBody({
      verdict: { ...verdict, waived: true, waiveReason: 'flaky suite, FP-1234', waiveUntil: '2026-09-30' },
      reportText: '# report',
      runUrl,
    });
    assert.match(body, /\*\*Waived\*\*: flaky suite, FP-1234 \(until 2026-09-30\)/);
  });

  test('machine-readable gate failures are surfaced', () => {
    const body = action.buildCommentBody({
      verdict: { ...verdict, gateFailures: ['insufficient evidence: 1 files reviewed (3 required)'] },
      reportText: '# report',
      runUrl,
    });
    assert.match(body, /\*\*Gate failures\*\*: insufficient evidence: 1 files reviewed \(3 required\)/);
  });

  test('missing violation counts render as zeros rather than undefined', () => {
    const body = action.buildCommentBody({
      verdict: { recommendation: 'Approve', qualityScore: 100 },
      reportText: '# report',
      runUrl,
    });
    assert.match(body, /\*\*Gating violations\*\*: 0 Critical \/ 0 High \/ 0 Medium \/ 0 Low/);
    assert.ok(!body.includes('undefined'));
  });

  test('formats header and marker with agent key', () => {
    const body = action.buildCommentBody({
      verdict: { recommendation: 'Approve', qualityScore: 90 },
      reportText: '# report',
      runUrl,
      agent: 'codex',
    });
    assert.match(body, /^<!-- tea-test-review:codex -->/);
    assert.match(body, /^## TEA Test Review \(codex\): Approve/m);
  });
});

describe('buildCommentMarker', () => {
  test('returns agent-tagged marker', () => {
    assert.strictEqual(action.buildCommentMarker('codex'), '<!-- tea-test-review:codex -->');
    assert.strictEqual(action.buildCommentMarker('claude'), '<!-- tea-test-review:claude -->');
    assert.strictEqual(action.buildCommentMarker(), '<!-- tea-test-review:claude -->');
  });
});

describe('findOwnComment', () => {
  test('finds the comment carrying the agent-tagged marker', () => {
    const found = action.findOwnComment([
      { id: 1, body: 'unrelated review note' },
      { id: 2, body: `<!-- tea-test-review:claude -->\n## TEA Test Review (claude): Approve` },
    ]);
    assert.strictEqual(found.id, 2);
  });

  test('finds a tagged comment matching the agent', () => {
    const found = action.findOwnComment(
      [
        { id: 1, body: '<!-- tea-test-review:claude -->\n## TEA Test Review (claude): Approve' },
        { id: 2, body: '<!-- tea-test-review:codex -->\n## TEA Test Review (codex): Approve' },
      ],
      'codex'
    );
    assert.strictEqual(found.id, 2);
  });

  test('only the default agent adopts an untagged legacy comment on upgrade', () => {
    const legacy = [{ id: 1, body: '<!-- tea-test-review -->\n## TEA Test Review: Approve' }];
    assert.strictEqual(action.findOwnComment(legacy, 'claude').id, 1);
  });

  test('a non-default agent never claims a legacy comment, so two agents racing on the same PR cannot clobber each other', () => {
    const legacy = [{ id: 1, body: '<!-- tea-test-review -->\n## TEA Test Review: Approve' }];
    assert.strictEqual(action.findOwnComment(legacy, 'codex'), null);
  });

  test('an exact agent-tagged match wins even when an unrelated legacy comment sorts earlier in the list', () => {
    const found = action.findOwnComment(
      [
        { id: 1, body: '<!-- tea-test-review -->\n## TEA Test Review: Approve' },
        { id: 2, body: '<!-- tea-test-review:codex -->\n## TEA Test Review (codex): Approve' },
      ],
      'codex'
    );
    assert.strictEqual(found.id, 2);
  });

  test('ignores a human comment that happens to mention the action', () => {
    assert.strictEqual(action.findOwnComment([{ id: 1, body: 'tea-test-review said 64/100' }]), null);
  });

  test('tolerates an empty list and a body-less comment', () => {
    assert.strictEqual(action.findOwnComment([]), null);
    assert.strictEqual(action.findOwnComment([{ id: 1 }, null]), null);
  });
});

describe('resolvePrNumber', () => {
  test('from a pull_request payload', () => {
    assert.strictEqual(action.resolvePrNumber({ pull_request: { number: 42 } }, {}), 42);
  });

  test('from an issue_comment payload', () => {
    assert.strictEqual(action.resolvePrNumber({ issue: { number: 7 } }, {}), 7);
  });

  test('falls back to refs/pull/N/merge', () => {
    assert.strictEqual(action.resolvePrNumber(null, { GITHUB_REF: 'refs/pull/13/merge' }), 13);
  });

  test('null off a pull request, so the comment step is skipped rather than guessed', () => {
    assert.strictEqual(action.resolvePrNumber(null, { GITHUB_REF: 'refs/heads/main' }), null);
    assert.strictEqual(action.resolvePrNumber({}, {}), null);
  });
});

describe('parseRepository and workflowRunUrl', () => {
  test('splits owner and repo', () => {
    assert.deepStrictEqual(action.parseRepository({ GITHUB_REPOSITORY: 'muratkeremozcan/tea-test-review' }), {
      owner: 'muratkeremozcan',
      repo: 'tea-test-review',
    });
  });

  test('null when it is absent or malformed', () => {
    assert.strictEqual(action.parseRepository({}), null);
    assert.strictEqual(action.parseRepository({ GITHUB_REPOSITORY: 'no-slash' }), null);
  });

  test('the run URL honours GITHUB_SERVER_URL, so GHES links resolve', () => {
    assert.strictEqual(
      action.workflowRunUrl({
        GITHUB_SERVER_URL: 'https://ghe.example.com/',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: '99',
      }),
      'https://ghe.example.com/o/r/actions/runs/99'
    );
  });
});

describe('isRetryableStatus', () => {
  for (const status of [429, 500, 502, 503]) {
    test(`${status} is retried`, () => assert.strictEqual(action.isRetryableStatus(status), true));
  }
  for (const status of [401, 403, 404, 422]) {
    test(`${status} is not retried, because it will not fix itself`, () => {
      assert.strictEqual(action.isRetryableStatus(status), false);
    });
  }
});

describe('runReviewCli', () => {
  for (const scenario of [
    { name: 'retries an agent failure that then passes', statuses: [3, 0], expectedStatus: 0 },
    { name: 'stops after one retry when the agent fails again', statuses: [3, 3], expectedStatus: 3 },
    { name: 'does not retry a verdict failure', statuses: [1], expectedStatus: 1 },
    { name: 'does not retry a configuration failure', statuses: [2], expectedStatus: 2 },
  ]) {
    test(scenario.name, () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-review-retry-'));
      const opts = {
        workspace,
        reportPath: 'review.md',
        jsonPath: 'review.json',
        credential: { name: 'TEST_AGENT_KEY', value: 'secret' },
      };
      const reportFile = path.join(workspace, opts.reportPath);
      const jsonFile = path.join(workspace, opts.jsonPath);
      let calls = 0;

      try {
        const result = action.runReviewCli(opts, ['--base', 'origin/main'], (command, args, options) => {
          calls += 1;
          assert.strictEqual(command, action.binaryName('tea-test-review'));
          assert.deepStrictEqual(args, ['--base', 'origin/main']);
          assert.strictEqual(options.cwd, workspace);
          assert.strictEqual(options.env.TEST_AGENT_KEY, 'secret');
          if (calls > 1) {
            assert.strictEqual(fs.existsSync(reportFile), false, 'retry starts without the prior report');
            assert.strictEqual(fs.existsSync(jsonFile), false, 'retry starts without the prior verdict');
          }
          fs.writeFileSync(reportFile, `attempt ${calls}\n`);
          fs.writeFileSync(jsonFile, JSON.stringify({ recommendation: `attempt ${calls}` }));
          return scenario.statuses[calls - 1];
        });

        assert.strictEqual(calls, scenario.statuses.length);
        assert.strictEqual(result.status, scenario.expectedStatus);
        assert.strictEqual(result.verdict.recommendation, `attempt ${calls}`);
        assert.strictEqual(fs.readFileSync(reportFile, 'utf8'), `attempt ${calls}\n`);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});

describe('githubRequest', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const err = (status) => ({ ok: false, status, json: async () => null, text: async () => 'boom' });

  test('sends the token, the pinned user agent, and a JSON body', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return ok({ id: 1 });
    };
    await action.githubRequest({
      apiUrl: 'https://api.github.com',
      token: 'sk-token',
      method: 'POST',
      path: '/repos/o/r/issues/1/comments',
      body: { body: 'hello' },
    });
    assert.strictEqual(calls[0].url, 'https://api.github.com/repos/o/r/issues/1/comments');
    assert.strictEqual(calls[0].init.headers.authorization, 'bearer sk-token');
    assert.strictEqual(calls[0].init.headers['user-agent'], 'muratkeremozcan/tea-test-review');
    assert.strictEqual(calls[0].init.body, '{"body":"hello"}');
  });

  test('a trailing slash on the API URL does not double up', async () => {
    let seen;
    global.fetch = async (url) => {
      seen = url;
      return ok({});
    };
    await action.githubRequest({ apiUrl: 'https://api.github.com/', token: 't', method: 'GET', path: '/x' });
    assert.strictEqual(seen, 'https://api.github.com/x');
  });

  test('retries a 500 and then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return calls === 1 ? err(500) : ok({ id: 2 });
    };
    const result = await action.githubRequest({ token: 't', method: 'GET', path: '/x' });
    assert.strictEqual(result.id, 2);
    assert.strictEqual(calls, 2);
  });

  test('does not retry a 403, which is a missing permission and not a blip', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return err(403);
    };
    await assert.rejects(action.githubRequest({ token: 't', method: 'GET', path: '/x' }), /returned 403/);
    assert.strictEqual(calls, 1);
  });

  test('retries a network error', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return ok({ id: 3 });
    };
    const result = await action.githubRequest({ token: 't', method: 'GET', path: '/x' });
    assert.strictEqual(result.id, 3);
  });
});

describe('upsertComment', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { owner: 'o', repo: 'r', token: 't', apiUrl: 'https://api.github.com' };

  /** Stub the two-call shape: list the comments, then write one. */
  function stub(pages) {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === 'GET') {
        // Anchored on the separator: an unanchored /page=/ also matches per_page.
        const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
        return { ok: true, status: 200, json: async () => pages[page - 1] || [], text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ id: 1 }), text: async () => '' };
    };
    return calls;
  }

  test('creates a comment when this action owns none', async () => {
    const calls = stub([[{ id: 5, body: 'someone else' }]]);
    const note = await action.upsertComment(ctx, 42, 'body text');
    assert.strictEqual(note, 'Created');
    const write = calls.find((call) => call.method === 'POST');
    assert.strictEqual(write.url, 'https://api.github.com/repos/o/r/issues/42/comments');
    assert.strictEqual(write.body.body, 'body text');
  });

  test('updates the one it owns rather than appending on every push', async () => {
    const calls = stub([[{ id: 5, body: 'someone else' }, { id: 9, body: `${action.COMMENT_MARKER} old` }]]);
    const note = await action.upsertComment(ctx, 42, 'new body');
    assert.strictEqual(note, 'Updated');
    const write = calls.find((call) => call.method === 'PATCH');
    assert.strictEqual(write.url, 'https://api.github.com/repos/o/r/issues/comments/9');
    assert.strictEqual(write.body.body, 'new body');
    assert.ok(!calls.some((call) => call.method === 'POST'));
  });

  test('pages through a busy pull request to find its own comment', async () => {
    // A full first page means there may be more; stopping there would post a
    // second comment on any PR with over 100 comments.
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'chatter' }));
    const calls = stub([firstPage, [{ id: 200, body: `${action.COMMENT_MARKER} old` }]]);
    const note = await action.upsertComment(ctx, 42, 'new body');
    assert.strictEqual(note, 'Updated');
    assert.strictEqual(calls.filter((call) => call.method === 'GET').length, 2);
  });

  test('stops listing on a short page', async () => {
    const calls = stub([[{ id: 1, body: 'one' }]]);
    await action.upsertComment(ctx, 42, 'body');
    assert.strictEqual(calls.filter((call) => call.method === 'GET').length, 1);
  });
});

describe('addReaction', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { owner: 'o', repo: 'r', token: 't', apiUrl: 'https://api.github.com' };

  test('posts an eyes reaction to the triggering comment by default', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ id: 1 }), text: async () => '' };
    };
    await action.addReaction(ctx, 9, 'eyes');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.github.com/repos/o/r/issues/comments/9/reactions');
    assert.strictEqual(calls[0].method, 'POST');
    assert.deepStrictEqual(calls[0].body, { content: 'eyes' });
  });

  test('swallows a failure as a warning: cosmetic, must never throw', async () => {
    global.fetch = async () => ({ ok: false, status: 403, json: async () => null, text: async () => 'nope' });
    const originalWrite = process.stdout.write;
    let logged = '';
    process.stdout.write = (msg) => {
      logged += msg;
      return true;
    };
    try {
      await action.addReaction(ctx, 9, 'eyes');
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.match(logged, /::warning::Could not react to the triggering comment/);
  });
});
// ─── check run ────────────────────────────────────────────────────────────────
//
// Shared shims for the check-run suites. The response literal was inlined a
// dozen times before, with the status and the text body drifting between
// copies; the file's own habit is a named helper (declaredDefault, buildWith).

const ghOk = (body, status = 200) => ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) });
const ghErr = (status, text = 'boom') => ({ ok: false, status, json: async () => null, text: async () => text });
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_URL = 'https://github.com/o/r/actions/runs/9';

/** Run fn with stdout captured, restoring the real one even when fn throws. */
async function captureStdout(fn) {
  const original = process.stdout.write;
  let logged = '';
  process.stdout.write = (msg) => {
    logged += msg;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return logged;
}

describe('fetchPullRequest', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const repo = { owner: 'o', repo: 'r' };
  const makeOpts = () => ({ token: 't', apiUrl: 'https://api.github.com', prCache: new Map() });

  test('fetches once and serves every later caller from the cache', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ghOk({ number: 7, calls });
    };
    const opts = makeOpts();
    assert.deepStrictEqual(await action.fetchPullRequest(opts, repo, 7), { number: 7, calls: 1 });
    assert.deepStrictEqual(await action.fetchPullRequest(opts, repo, 7), { number: 7, calls: 1 });
    assert.strictEqual(calls, 1);
  });

  test('a different pull request is a different cache entry', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ghOk({ n: calls });
    };
    const opts = makeOpts();
    assert.deepStrictEqual(await action.fetchPullRequest(opts, repo, 7), { n: 1 });
    assert.deepStrictEqual(await action.fetchPullRequest(opts, repo, 8), { n: 2 });
    assert.strictEqual(calls, 2);
  });

  test('the same number in a different repository is a different entry', async () => {
    // The key carries owner and repo because one action run can be pointed at
    // another repository through github-api-url and a passed token.
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ghOk({ n: calls });
    };
    const opts = makeOpts();
    assert.deepStrictEqual(await action.fetchPullRequest(opts, { owner: 'o', repo: 'a' }, 7), { n: 1 });
    assert.deepStrictEqual(await action.fetchPullRequest(opts, { owner: 'o', repo: 'b' }, 7), { n: 2 });
    assert.deepStrictEqual(await action.fetchPullRequest(opts, { owner: 'p', repo: 'a' }, 7), { n: 3 });
  });

  test('an unparseable 200 is not cached, so the next caller gets its own request', async () => {
    // githubRequest yields null for a body it cannot parse. Caching that turned
    // the base-ref lookup, which used to recover on its own request, into a
    // guaranteed broken gate.
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return calls === 1
        ? {
            ok: true,
            status: 200,
            json: async () => {
              throw new Error('truncated');
            },
            text: async () => '',
          }
        : ghOk({ number: 7 });
    };
    const opts = makeOpts();
    assert.strictEqual(await action.fetchPullRequest(opts, repo, 7), null);
    assert.strictEqual(opts.prCache.size, 0);
    assert.deepStrictEqual(await action.fetchPullRequest(opts, repo, 7), { number: 7 });
    assert.strictEqual(calls, 2);
  });

  test('a thrown request caches nothing, so a transient failure is retried', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ghErr(404, 'gone');
    };
    const opts = makeOpts();
    await assert.rejects(action.fetchPullRequest(opts, repo, 7));
    assert.strictEqual(opts.prCache.size, 0);
  });

  test('no cache still works, so an existing caller that passes none is unchanged', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ghOk({ number: 7 });
    };
    const opts = { token: 't', apiUrl: 'https://api.github.com' };
    await action.fetchPullRequest(opts, repo, 7);
    await action.fetchPullRequest(opts, repo, 7);
    assert.strictEqual(calls, 2);
  });

  test('the head-SHA lookup and the base-ref lookup share one API call', async () => {
    // This is the cache's whole reason for existing: resolveRunBaseRef already
    // made this request, and the check run needed the head SHA off the same body.
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return ghOk({ head: { sha: 'abc123' }, base: { ref: 'release/2.0' } });
    };
    const opts = { baseRef: 'origin/main', token: 't', apiUrl: 'https://api.github.com', prCache: new Map() };
    assert.strictEqual(await action.resolveHeadSha(opts, repo, 7, null), 'abc123');
    assert.strictEqual(
      await action.resolveRunBaseRef(opts, { issue: { number: 7 } }, { GITHUB_REPOSITORY: 'o/r' }),
      'origin/release/2.0'
    );
    assert.strictEqual(calls, 1);
  });
});

describe('resolveHeadSha', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const repo = { owner: 'o', repo: 'r' };
  const makeOpts = () => ({ token: 't', apiUrl: 'https://api.github.com', prCache: new Map() });

  test('prefers the head SHA already in a pull_request payload, with no API call', async () => {
    global.fetch = async () => {
      throw new Error('the payload already had it');
    };
    const payload = { pull_request: { head: { sha: 'abc123' } } };
    assert.strictEqual(await action.resolveHeadSha(makeOpts(), repo, 7, payload), 'abc123');
  });

  test('falls back to the pulls API when the payload carries no commit', async () => {
    let seen;
    global.fetch = async (url) => {
      seen = url;
      return ghOk({ head: { sha: 'deadbee' } });
    };
    assert.strictEqual(await action.resolveHeadSha(makeOpts(), repo, 7, { issue: { number: 7 } }), 'deadbee');
    assert.strictEqual(seen, 'https://api.github.com/repos/o/r/pulls/7');
  });

  test('a pull request with no head SHA is null, never a partial string', async () => {
    global.fetch = async () => ghOk({ head: {} });
    assert.strictEqual(await action.resolveHeadSha(makeOpts(), repo, 7, null), null);
  });

  test('a non-string head SHA is null, so no check run is aimed at a number', async () => {
    global.fetch = async () => ghOk({ head: { sha: 123 } });
    assert.strictEqual(await action.resolveHeadSha(makeOpts(), repo, 7, null), null);
  });

  test('an empty head SHA in the payload falls through to the API, not into a blank check run', async () => {
    global.fetch = async () => ghOk({ head: { sha: 'fromapi' } });
    const payload = { pull_request: { head: { sha: '' } } };
    assert.strictEqual(await action.resolveHeadSha(makeOpts(), repo, 7, payload), 'fromapi');
  });

  test('a 404 rejects, which is the rejection openCheckRun absorbs', async () => {
    global.fetch = async () => ghErr(404, 'not found');
    await assert.rejects(action.resolveHeadSha(makeOpts(), repo, 7, null), /404/);
  });
});

describe('findOpenCheckRun', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { owner: 'o', repo: 'r', token: 't', apiUrl: 'https://api.github.com' };

  test('queries the commit by check name and returns the id still in flight', async () => {
    let seen;
    global.fetch = async (url) => {
      seen = url;
      return ghOk({ check_runs: [{ id: 1, status: 'completed' }, { id: 2, status: 'in_progress' }] });
    };
    assert.strictEqual(await action.findOpenCheckRun(ctx, 'abc123', 'TEA Test Review (claude)'), 2);
    assert.strictEqual(
      seen,
      'https://api.github.com/repos/o/r/commits/abc123/check-runs?check_name=TEA%20Test%20Review%20(claude)&per_page=100'
    );
  });

  test('a queued run counts as open, so a stalled attempt is adopted rather than duplicated', async () => {
    global.fetch = async () => ghOk({ check_runs: [{ id: 3, status: 'queued' }] });
    assert.strictEqual(await action.findOpenCheckRun(ctx, 'abc123', 'n'), 3);
  });

  test('only completed runs means nothing to adopt', async () => {
    global.fetch = async () => ghOk({ check_runs: [{ id: 1, status: 'completed' }] });
    assert.strictEqual(await action.findOpenCheckRun(ctx, 'abc123', 'n'), null);
  });

  test('an open run with no integer id is skipped, so no PATCH is aimed at a guess', async () => {
    global.fetch = async () => ghOk({ check_runs: [{ id: 'x', status: 'in_progress' }] });
    assert.strictEqual(await action.findOpenCheckRun(ctx, 'abc123', 'n'), null);
  });

  test('a malformed response is null, never a guessed id', async () => {
    global.fetch = async () => ghOk({});
    assert.strictEqual(await action.findOpenCheckRun(ctx, 'abc123', 'n'), null);
  });
});

describe('createCheckRun', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { owner: 'o', repo: 'r', token: 't', apiUrl: 'https://api.github.com' };

  /** Answers the adopt-or-create GET with `check_runs`, and every other call with `body`. */
  const stub = (calls, body, { existing = [] } = {}) => async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return init.method === 'GET' ? ghOk({ check_runs: existing }) : ghOk(body, 201);
  };

  test('opens the run as in_progress against the head SHA and returns its id', async () => {
    const calls = [];
    global.fetch = stub(calls, { id: 55 });
    const id = await action.createCheckRun(ctx, {
      headSha: 'abc123',
      name: 'TEA Test Review (claude)',
      detailsUrl: RUN_URL,
    });
    assert.strictEqual(id, 55);
    assert.strictEqual(calls.length, 2, 'one adopt-or-create lookup, then one create');
    assert.strictEqual(calls[1].url, 'https://api.github.com/repos/o/r/check-runs');
    assert.strictEqual(calls[1].method, 'POST');
    assert.strictEqual(calls[1].body.head_sha, 'abc123');
    assert.strictEqual(calls[1].body.status, 'in_progress');
    assert.strictEqual(calls[1].body.name, 'TEA Test Review (claude)');
    assert.strictEqual(calls[1].body.details_url, RUN_URL);
    // A malformed timestamp is a 422 the caller then swallows as a warning, so
    // the failure mode of getting this wrong is a silently missing check run.
    assert.match(calls[1].body.started_at, ISO_8601);
  });

  test('the in-progress output is what the pull request shows for the whole run', async () => {
    const calls = [];
    global.fetch = stub(calls, { id: 55 });
    await action.createCheckRun(ctx, { headSha: 'abc123', name: 'n', detailsUrl: RUN_URL });
    assert.deepStrictEqual(calls[1].body.output, {
      title: 'Review in progress',
      summary: `The TEA test review is running. [Live log](${RUN_URL})`,
    });
  });

  test('adopts a run an earlier attempt left open instead of stacking a second under one name', async () => {
    const calls = [];
    global.fetch = stub(calls, { id: 99 }, { existing: [{ id: 7, status: 'in_progress' }] });
    assert.strictEqual(await action.createCheckRun(ctx, { headSha: 'abc123', name: 'n', detailsUrl: 'u' }), 7);
    assert.strictEqual(calls.length, 1, 'the create must not run when an open run was adopted');
  });

  test('a failed lookup still creates, so the adopt path can never cost the check run', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(init.method);
      return init.method === 'GET' ? ghErr(403, 'nope') : ghOk({ id: 55 }, 201);
    };
    assert.strictEqual(await action.createCheckRun(ctx, { headSha: 'a', name: 'n', detailsUrl: 'u' }), 55);
    assert.deepStrictEqual(calls, ['GET', 'POST']);
  });

  test('a response with no id is null, so nothing is later patched by guess', async () => {
    global.fetch = stub([], {});
    assert.strictEqual(await action.createCheckRun(ctx, { headSha: 'a', name: 'n', detailsUrl: 'u' }), null);
  });

  test('a non-integer id is null, for the same reason', async () => {
    global.fetch = stub([], { id: '55' });
    assert.strictEqual(await action.createCheckRun(ctx, { headSha: 'a', name: 'n', detailsUrl: 'u' }), null);
  });

  test('a 403 on the missing permission warns and returns null: cosmetic, never throws', async () => {
    global.fetch = async () => ghErr(403, 'Resource not accessible');
    let id;
    const logged = await captureStdout(async () => {
      id = await action.createCheckRun(ctx, { headSha: 'a', name: 'n', detailsUrl: 'u' });
    });
    assert.strictEqual(id, null);
    assert.match(logged, /::warning::Could not create the check run/);
    assert.match(logged, /checks: write/);
  });
});

describe('completeCheckRun', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ctx = { owner: 'o', repo: 'r', token: 't', apiUrl: 'https://api.github.com' };

  test('patches the run to completed with its conclusion and output', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return ghOk({ id: 55 });
    };
    await action.completeCheckRun(ctx, 55, { conclusion: 'success', title: 'Approve', summary: 'all good' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.github.com/repos/o/r/check-runs/55');
    assert.strictEqual(calls[0].method, 'PATCH');
    assert.strictEqual(calls[0].body.status, 'completed');
    assert.strictEqual(calls[0].body.conclusion, 'success');
    assert.deepStrictEqual(calls[0].body.output, { title: 'Approve', summary: 'all good' });
    assert.match(calls[0].body.completed_at, ISO_8601);
  });

  test('a null id is a no-op, so a run that was never opened is never patched', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return ghOk({});
    };
    await action.completeCheckRun(ctx, null, { conclusion: 'success', title: 't', summary: 's' });
    assert.strictEqual(called, false);
  });

  test('a rejected output is retried bare, so a summary problem cannot pin the run', async () => {
    const bodies = [];
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.output ? ghErr(422, 'output too large') : ghOk({ id: 55 });
    };
    const logged = await captureStdout(() =>
      action.completeCheckRun(ctx, 55, { conclusion: 'failure', title: 't', summary: 's' })
    );
    assert.strictEqual(bodies.length, 2);
    assert.strictEqual(bodies[1].status, 'completed');
    assert.strictEqual(bodies[1].conclusion, 'failure');
    assert.strictEqual(bodies[1].output, undefined);
    assert.match(bodies[1].completed_at, ISO_8601);
    assert.match(logged, /::warning::Could not write the check run's summary/);
  });

  test('both attempts failing warns that the run stays open, and still never throws', async () => {
    global.fetch = async () => ghErr(404, 'gone');
    const logged = await captureStdout(() =>
      action.completeCheckRun(ctx, 55, { conclusion: 'success', title: 't', summary: 's' })
    );
    assert.match(logged, /::warning::Could not complete the check run/);
    assert.match(logged, /stays in progress/);
  });
});

describe('openCheckRun', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const repo = { owner: 'o', repo: 'r' };
  const ctx = { owner: 'o', repo: 'r', token: 't', apiUrl: 'https://api.github.com' };
  const makeOpts = (over = {}) => ({
    checkRun: true,
    checkRunName: 'TEA Test Review',
    token: 't',
    apiUrl: 'https://api.github.com',
    prCache: new Map(),
    agent: { key: 'claude' },
    ...over,
  });
  const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '9' };

  const openWith = (opts, payload, over = {}) => {
    const bodies = [];
    global.fetch = async (url, init) => {
      if (init.method === 'GET') return ghOk({ check_runs: [] });
      bodies.push(JSON.parse(init.body));
      return ghOk({ id: 55 }, 201);
    };
    return { bodies, run: () => action.openCheckRun(opts, ctx, repo, payload, { ...env, ...over }) };
  };

  test('opens against the payload head SHA and links this workflow run', async () => {
    const { bodies, run } = openWith(makeOpts(), { pull_request: { number: 4, head: { sha: 'abc123' } } });
    assert.strictEqual(await run(), 55);
    assert.strictEqual(bodies[0].name, 'TEA Test Review');
    assert.strictEqual(bodies[0].details_url, RUN_URL);
    assert.strictEqual(bodies[0].head_sha, 'abc123');
  });

  test('the name never moves with the agent, because branch protection matches it exactly', async () => {
    // A mention can switch vendors mid-pull-request. A name carrying the vendor
    // would stop reporting under the name that was required.
    const a = openWith(makeOpts(), { pull_request: { number: 4, head: { sha: 'abc' } } });
    await a.run();
    const b = openWith(makeOpts({ agent: { key: 'codex' } }), { pull_request: { number: 4, head: { sha: 'abc' } } });
    await b.run();
    assert.strictEqual(a.bodies[0].name, b.bodies[0].name);
    assert.match(a.bodies[0].output.summary, /running on claude\./);
    assert.match(b.bodies[0].output.summary, /running on codex\./);
  });

  test('a caller-set name wins, so two reviews in one workflow do not share a run', async () => {
    const { bodies, run } = openWith(makeOpts({ checkRunName: 'TEA Test Review (codex)' }), {
      pull_request: { number: 4, head: { sha: 'abc' } },
    });
    await run();
    assert.strictEqual(bodies[0].name, 'TEA Test Review (codex)');
  });

  test('check-run false never touches the API', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return ghOk({});
    };
    assert.strictEqual(await action.openCheckRun(makeOpts({ checkRun: false }), ctx, repo, {}, env), null);
    assert.strictEqual(called, false);
  });

  test('an unusable token warns rather than failing silently, matching the comment path', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return ghOk({});
    };
    let id;
    const logged = await captureStdout(async () => {
      id = await action.openCheckRun(makeOpts(), null, repo, {}, env);
    });
    assert.strictEqual(id, null);
    assert.strictEqual(called, false);
    assert.match(logged, /::warning::check-run is enabled but there is no usable github-token/);
  });

  test('no pull request in context opens nothing', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return ghOk({});
    };
    assert.strictEqual(await action.openCheckRun(makeOpts(), ctx, repo, {}, { ...env, GITHUB_REF: 'refs/heads/main' }), null);
    assert.strictEqual(called, false);
  });

  test('a head SHA that cannot be resolved warns and lets the review run without a check', async () => {
    global.fetch = async () => ghErr(404, 'not found');
    let id;
    const logged = await captureStdout(async () => {
      id = await action.openCheckRun(makeOpts(), ctx, repo, { issue: { number: 4 } }, env);
    });
    assert.strictEqual(id, null);
    assert.match(logged, /::warning::Could not resolve the head SHA of #4/);
    assert.match(logged, /The review still runs without a check run/);
  });
});

describe('clampBytes', () => {
  test('leaves anything inside the budget untouched', () => {
    assert.strictEqual(action.clampBytes('short', 100), 'short');
  });

  test('trims to the budget and says it trimmed', () => {
    const out = action.clampBytes('x'.repeat(500), 100);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 100);
    assert.match(out, /_\(truncated\)_$/);
  });

  test('counts bytes, because the API limit is bytes and an emoji is four of them', () => {
    // 30 emoji is 120 bytes and 60 characters: a character-based clamp would
    // send this through and take a 422.
    const out = action.clampBytes('🙂'.repeat(30), 60);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 60);
  });

  test('never cuts a multi-byte character in half', () => {
    const out = action.clampBytes('🙂'.repeat(30), 60);
    assert.ok(!out.includes('\uFFFD'));
    assert.strictEqual(Buffer.from(out, 'utf8').toString('utf8'), out);
  });

  test('a null summary is an empty string, never the word "null"', () => {
    assert.strictEqual(action.clampBytes(null, 100), '');
  });
});

describe('retryAfterMs', () => {
  test('honours the header GitHub sends, because a shorter wait burns another request', () => {
    assert.strictEqual(action.retryAfterMs({ get: () => '5' }, 1), 5000);
  });

  test('caps a hostile value so one response cannot stall the job', () => {
    assert.strictEqual(action.retryAfterMs({ get: () => '99999' }, 1), 60000);
  });

  test('falls back to the linear backoff when there is no header', () => {
    assert.strictEqual(action.retryAfterMs({ get: () => null }, 3), 3000);
    assert.strictEqual(action.retryAfterMs(null, 2), 2000);
  });

  test('a non-numeric or non-positive header falls back too', () => {
    assert.strictEqual(action.retryAfterMs({ get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' }, 1), 1000);
    assert.strictEqual(action.retryAfterMs({ get: () => '0' }, 1), 1000);
  });
});

describe('checkRunConclusion', () => {
  test('a passing verdict is success', () => {
    assert.strictEqual(action.checkRunConclusion(0, { recommendation: 'Approve' }), 'success');
  });

  test('a waived failure is still a pass, because the step exited 0', () => {
    assert.strictEqual(action.checkRunConclusion(0, { waived: true }), 'success');
  });

  test('a skipped review is neutral: no evidence of quality, and no reason to block', () => {
    assert.strictEqual(action.checkRunConclusion(0, { skipped: true }), 'neutral');
  });

  test('a dry run is neutral, because --agent none reviewed nothing', () => {
    assert.strictEqual(action.checkRunConclusion(0, { promptOnly: true }), 'neutral');
  });

  test('only a real boolean skips, so a string "true" from a malformed verdict is not one', () => {
    assert.strictEqual(action.checkRunConclusion(0, { skipped: 'true' }), 'success');
    assert.strictEqual(action.checkRunConclusion(0, { promptOnly: 'true' }), 'success');
  });

  test('a verdict failure is failure', () => {
    assert.strictEqual(action.checkRunConclusion(1, { recommendation: 'Block' }), 'failure');
  });

  for (const status of [2, 3]) {
    test(`exit ${status} is a broken gate and is reported as failure, never as a pass`, () => {
      assert.strictEqual(action.checkRunConclusion(status, null), 'failure');
    });
  }

  test('a skipped verdict on a non-zero exit is still failure: the exit code wins', () => {
    assert.strictEqual(action.checkRunConclusion(3, { skipped: true }), 'failure');
  });

  test('a missing verdict on exit 0 is success, matching the step it mirrors', () => {
    assert.strictEqual(action.checkRunConclusion(0, null), 'success');
  });
});

describe('checkRunReport', () => {
  const link = `[Full log](${RUN_URL})`;

  test('a skipped review names the reason and links the run', () => {
    const out = action.checkRunReport(0, { skipped: true, reason: 'no changed test files' }, 'success', RUN_URL);
    assert.strictEqual(out.title, 'Skipped');
    assert.strictEqual(out.summary, `No changed test files to review: no changed test files.\n\n${link}`);
  });

  test('a skip with no reason still reads as a skip, never as "undefined"', () => {
    const out = action.checkRunReport(0, { skipped: true }, 'success', RUN_URL);
    assert.strictEqual(out.summary, `No changed test files to review: nothing in the diff to review.\n\n${link}`);
  });

  test('a dry run says no review happened, never a score of zero violations', () => {
    const out = action.checkRunReport(0, { promptOnly: true, files: ['a.test.ts'] }, 'review passed', RUN_URL);
    assert.strictEqual(out.title, 'No review performed');
    assert.strictEqual(
      out.summary,
      'The CLI ran with `--agent none`, so it built the prompt and stopped. This is a dry run, not a verdict.' +
        `\n\n${link}`
    );
  });

  test('a passing verdict carries the recommendation, the gating score and the counts', () => {
    const out = action.checkRunReport(
      0,
      {
        recommendation: 'Approve',
        gatingQualityScore: 92,
        gatingViolations: { critical: 0, high: 1, medium: 2, low: 3 },
        reviewedFiles: ['a.test.ts', 'b.test.ts'],
      },
      'success',
      RUN_URL
    );
    assert.strictEqual(out.title, 'Approve');
    assert.strictEqual(
      out.summary,
      `Gating quality score 92/100 across 2 reviewed file(s).\n\n0 critical, 1 high, 2 medium, 3 low.\n\n${link}`
    );
  });

  test('a gating score of 0 is reported as 0, the falsiest valid score there is', () => {
    const out = action.checkRunReport(1, { recommendation: 'Block', gatingQualityScore: 0 }, 'verdict failure', RUN_URL);
    assert.match(out.summary, /^Gating quality score 0\/100 /);
  });

  test('a waived failure says so, so a green check is never unexplained', () => {
    const out = action.checkRunReport(0, { recommendation: 'Approve', waived: true, waiveReason: 'hotfix' }, 'success', RUN_URL);
    assert.match(out.summary, /Verdict failure waived: hotfix\./);
  });

  test('a waiver with no reason still reads as a waiver', () => {
    const out = action.checkRunReport(0, { recommendation: 'Approve', waived: true }, 'success', RUN_URL);
    assert.match(out.summary, /Verdict failure waived: no reason recorded\./);
  });

  test('a waiver is never claimed on a failing exit, because a waived run exits 0', () => {
    const out = action.checkRunReport(1, { recommendation: 'Block', waived: true, waiveReason: 'hotfix' }, 'verdict failure', RUN_URL);
    assert.ok(!out.summary.includes('waived'));
  });

  test('a verdict failure keeps its recommendation as the title', () => {
    const out = action.checkRunReport(1, { recommendation: 'Request Changes', gatingQualityScore: 41 }, 'verdict failure', RUN_URL);
    assert.strictEqual(out.title, 'Request Changes');
    assert.match(out.summary, /^Gating quality score 41\/100 /);
  });

  test('a broken gate is reported as broken rather than as a low score', () => {
    const out = action.checkRunReport(3, null, 'agent or report failure', RUN_URL);
    assert.strictEqual(out.title, 'Broken gate');
    assert.strictEqual(
      out.summary,
      `The review did not produce a verdict: agent or report failure. Treat this as a broken gate, not as approved tests.\n\n${link}`
    );
  });

  test('an unreadable verdict on exit 1 falls back to the exit meaning for a title', () => {
    const out = action.checkRunReport(1, null, 'verdict failure', RUN_URL);
    assert.strictEqual(out.title, 'verdict failure');
    assert.strictEqual(
      out.summary,
      `Gating quality score not recorded across 0 reviewed file(s).\n\n0 critical, 0 high, 0 medium, 0 low.\n\n${link}`
    );
  });
});
describe('fenceLeadingFrontmatter', () => {
  test('fences a leading frontmatter block and leaves the body untouched', () => {
    const out = action.fenceLeadingFrontmatter("---\na: 1\nb: 2\n---\n\n# Title\n\ntext\n");
    assert.strictEqual(out, "```yaml\na: 1\nb: 2\n```\n\n# Title\n\ntext\n");
  });

  test('a thematic break inside the body is not mistaken for frontmatter', () => {
    const text = '# Title\n\n---\n\nsection\n';
    assert.strictEqual(action.fenceLeadingFrontmatter(text), text);
  });

  test('an unclosed leading marker is left alone rather than half-fenced', () => {
    const text = '---\na: 1\n\n# Title\n';
    assert.strictEqual(action.fenceLeadingFrontmatter(text), text);
  });

  test('frontmatter containing a fence is left alone, so ours cannot end early', () => {
    const text = '---\nnote: "```"\n---\n\n# Title\n';
    assert.strictEqual(action.fenceLeadingFrontmatter(text), text);
  });

  test('a missing report is a string, not a crash', () => {
    assert.strictEqual(action.fenceLeadingFrontmatter(null), '');
  });
});
