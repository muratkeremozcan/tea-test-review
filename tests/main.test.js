/**
 * Tests for the tea-test-review action.
 *
 * The action is a wrapper over the `tea-test-review` CLI, so the review itself
 * (the comment text and its upsert, the check run, the retry, the base-ref
 * lookup, the packaged skill) is tested in the CLI's own repository. What is
 * pinned here is the wiring:
 *
 *   - "an existing workflow runs unchanged" runs main.js as a child process with
 *     every declared input set, against stand-ins for `npm` and the CLI, and
 *     asserts the exact argv, environment and outputs. It is the end-to-end
 *     proof that every input still reaches the CLI.
 *   - "buildCliArgs" and "action.yml defaults", because a wrapper's whole job is
 *     to state every input the review branches on. A duplicated default that
 *     drifts from action.yml changes what the agent reviews without changing
 *     anything visible.
 *   - "verdict handling", because a skip, a pass, a waiver and a broken gate must
 *     never read alike.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const action = require('../main.js');

const ACTION_YML = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

/** Declared default for an input in action.yml, so a test can pin a duplicate against it. */
function declaredDefault(inputName) {
  const block = new RegExp(`^  ${inputName}:\\n([\\s\\S]*?)(?=^  \\S|^outputs:)`, 'm').exec(ACTION_YML);
  assert.ok(block, `action.yml has no input named ${inputName}`);
  const match = /^    default: '(.*)'$/m.exec(block[1]);
  return match ? match[1] : null;
}

/** Names declared under `inputs:` in action.yml. */
function declaredInputs() {
  const section = ACTION_YML.slice(ACTION_YML.indexOf('\ninputs:'), ACTION_YML.indexOf('\noutputs:'));
  return [...section.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
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

  test('is empty when neither the caller nor the event states one, leaving the lookup to the CLI', () => {
    // An issue_comment run carries no base ref. The CLI resolves it through
    // --pr, and a push run falls to the CLI's own origin/main.
    assert.strictEqual(action.resolveBaseRef('', {}), '');
    assert.strictEqual(action.resolveBaseRef(undefined, { GITHUB_BASE_REF: '' }), '');
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
    assert.deepStrictEqual(
      action.resolveTrigger({ mode: 'auto', mentions, agentInput: 'claude', payload: { issue: { number: 7 }, comment: { body: '@claude', author_association: 'MEMBER', user: { type: 'User' } } }, eventName: 'issue_comment' }),
      { proceed: false, reason: 'the comment is not on a pull request' }
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

  test('pull_request_target is skipped: it runs on the base branch, so there is nothing to review', () => {
    const result = action.resolveTrigger({ mode: 'auto', mentions: [], agentInput: 'claude', payload: {}, eventName: 'pull_request_target' });
    assert.strictEqual(result.proceed, false);
    assert.match(result.reason, /pull_request_target/);
  });

  test('a mention of the configured vendor is not a switch, so its model and agent-args stand', () => {
    const result = action.resolveTrigger({
      mode: 'auto',
      mentions: ['@claude', '@codex'],
      agentInput: 'claude',
      payload: { issue: { number: 7, pull_request: {} }, comment: { body: '@claude look', author_association: 'MEMBER', user: { type: 'User' } } },
      eventName: 'issue_comment',
    });
    assert.strictEqual(result.agent, 'claude');
    assert.strictEqual(result.agentSwitched, false);
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

  test('a @codex mention switches the resolved agent, the same value the artifact name reads', () => {
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

  test('a vendor switch also resets the vendor-describing inputs, so the switched agent installs and runs as itself', () => {
    const opts = action.buildOptions(
      { ...baseEnv, 'INPUT_OPENAI-API-KEY': 'sk-oai', 'INPUT_AGENT-PACKAGE': '@anthropic-ai/claude-code@2.0.0', 'INPUT_AGENT-COMMAND': 'claude-beta' },
      { agentOverride: 'codex', agentSwitched: true }
    );
    assert.strictEqual(opts.agent.packageSpec, '@openai/codex@latest');
    assert.strictEqual(opts.agent.command, 'codex');
  });

  test('without a switch the configured model and agent-args stand', () => {
    const opts = action.buildOptions({ ...baseEnv, INPUT_MODEL: 'claude-sonnet-4-6' }, { agentOverride: 'claude', agentSwitched: false });
    assert.strictEqual(opts.cli.model, 'claude-sonnet-4-6');
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

describe('childEnv publishing context', () => {
  const userInfo = { homedir: '/home/runner', username: 'runner' };

  test('the token and API URL reach the CLI through the environment, never argv', () => {
    const env = action.childEnv(null, { PATH: '/usr/bin' }, userInfo, { token: 'ghs_x', apiUrl: 'https://ghe.example/api/v3' });
    assert.strictEqual(env.GITHUB_TOKEN, 'ghs_x');
    assert.strictEqual(env.GITHUB_API_URL, 'https://ghe.example/api/v3');
  });

  test('an empty token leaves the runner environment alone', () => {
    const env = action.childEnv(null, { GITHUB_TOKEN: 'from-runner' }, userInfo, { token: '' });
    assert.strictEqual(env.GITHUB_TOKEN, 'from-runner');
  });
});

describe('buildCliArgs', () => {
  const base = {
    reportPath: 'test-review.md',
    jsonPath: 'test-review.json',
    cliAgent: 'claude',
    agentCommand: 'claude',
  };

  test('the mandatory shape: executor, both output files, and the CLI retry', () => {
    assert.deepStrictEqual(action.buildCliArgs(base), [
      '--agent',
      'claude',
      '--output',
      'test-review.md',
      '--json',
      'test-review.json',
      '--retries',
      '1',
    ]);
  });

  test('the action never names a skill: the CLI reviews with the skill packaged beside it', () => {
    // --skill-root or --project-skill here would hand the pull request a way to
    // edit the reviewer that judges it. The packaged skill is out of its reach.
    const args = action.buildCliArgs({ ...base, baseRef: 'origin/main', pr: 7, publish: true, checkRunName: 'x', comment: true, checkRun: true });
    for (const flag of ['--skill-root', '--project-skill']) assert.ok(!args.includes(flag), flag);
  });

  test('the retry is the CLI\'s own, once, so the action runs the agent at most twice', () => {
    const args = action.buildCliArgs(base);
    assert.strictEqual(args[args.indexOf('--retries') + 1], String(action.CLI_RETRIES));
    assert.strictEqual(action.CLI_RETRIES, 1);
  });

  test('a stated base ref becomes --base, and an absent one passes nothing', () => {
    const stated = action.buildCliArgs({ ...base, baseRef: 'origin/release' });
    assert.strictEqual(stated[stated.indexOf('--base') + 1], 'origin/release');
    assert.ok(!action.buildCliArgs({ ...base, baseRef: '' }).includes('--base'));
  });

  test('--pr carries the pull request, which is both the base lookup and the publish target', () => {
    const args = action.buildCliArgs({ ...base, pr: 7 });
    assert.strictEqual(args[args.indexOf('--pr') + 1], '7');
    assert.ok(!action.buildCliArgs({ ...base, pr: null }).includes('--pr'));
  });

  test('publishing turns on --github with the check name and the artifact the upload step creates', () => {
    const args = action.buildCliArgs({
      ...base,
      publish: true,
      comment: true,
      checkRun: true,
      checkRunName: 'TEA Test Review',
      artifactName: 'tea-test-review-review-claude',
    });
    assert.ok(args.includes('--github'));
    assert.strictEqual(args[args.indexOf('--check-name') + 1], 'TEA Test Review');
    assert.strictEqual(args[args.indexOf('--artifact-name') + 1], 'tea-test-review-review-claude');
    assert.ok(!args.includes('--no-pr-comment'));
    assert.ok(!args.includes('--no-check-run'));
  });

  test('comment false and check-run false each switch off their own surface', () => {
    const noComment = action.buildCliArgs({ ...base, publish: true, comment: false, checkRun: true, checkRunName: 'x' });
    assert.ok(noComment.includes('--no-pr-comment') && !noComment.includes('--no-check-run'));
    const noCheck = action.buildCliArgs({ ...base, publish: true, comment: true, checkRun: false, checkRunName: 'x' });
    assert.ok(noCheck.includes('--no-check-run') && !noCheck.includes('--no-pr-comment'));
  });

  test('nothing GitHub-shaped is passed when not publishing, because the CLI rejects those flags without --github', () => {
    const args = action.buildCliArgs({ ...base, publish: false, comment: false, checkRun: false, checkRunName: 'x', artifactName: 'a' });
    for (const flag of ['--github', '--check-name', '--artifact-name', '--no-pr-comment', '--no-check-run']) {
      assert.ok(!args.includes(flag), `${flag} should be absent`);
    }
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
    assert.ok(!action.buildCliArgs(base).includes('--agent-cmd'));
    assert.ok(!action.buildCliArgs({ ...base, cliAgent: 'codex', agentCommand: 'codex' }).includes('--agent-cmd'));
  });

  test('--agent-cmd overrides the executable on top of whichever --agent adapter was selected', () => {
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

  test("an empty model passes nothing, leaving the CLI's per-vendor pinned default in charge", () => {
    assert.ok(!action.buildCliArgs({ ...base, model: '' }).includes('--model'));
  });

  test('a dry run drops --model, which the CLI rejects with --agent none', () => {
    assert.ok(!action.buildCliArgs({ ...base, model: 'opus', dryRun: true }).includes('--model'));
    assert.ok(action.buildCliArgs({ ...base, model: 'opus', dryRun: false }).includes('--model'));
  });

  test('focus becomes --focus', () => {
    const args = action.buildCliArgs({ ...base, focus: 'look at auth' });
    assert.strictEqual(args[args.indexOf('--focus') + 1], 'look at auth');
    assert.ok(!action.buildCliArgs({ ...base, focus: '' }).includes('--focus'));
  });

  test("a custom vendor's credential is allowlisted with --env-pass", () => {
    const args = action.buildCliArgs({ ...base, envPass: 'GEMINI_API_KEY' });
    assert.strictEqual(args[args.indexOf('--env-pass') + 1], 'GEMINI_API_KEY');
  });

  test('extra-args land last, so a caller can override an earlier flag', () => {
    const args = action.buildCliArgs({ ...base, minScore: '80', extraArgs: ['--min-score', '90', '--fail-on-skip'] });
    assert.deepStrictEqual(args.slice(-3), ['--min-score', '90', '--fail-on-skip']);
  });

  test('a caller who sets --retries in extra-args wins over the action\'s one retry', () => {
    const args = action.buildCliArgs({ ...base, extraArgs: ['--retries', '0'] });
    assert.deepStrictEqual(args.slice(-2), ['--retries', '0']);
  });
});

describe('planGithub', () => {
  const inputs = { comment: true, checkRun: true, baseRef: '', extraArgs: [] };

  test('publishes with the pull request when comment or check-run is on', () => {
    assert.deepStrictEqual(action.planGithub(inputs, 7), { dryRun: false, publish: true, pr: 7 });
    assert.strictEqual(action.planGithub({ ...inputs, checkRun: false }, 7).publish, true);
    assert.strictEqual(action.planGithub({ ...inputs, comment: false }, 7).publish, true);
  });

  test('both surfaces off publishes nothing, which the CLI would reject as an empty --github', () => {
    assert.strictEqual(action.planGithub({ ...inputs, comment: false, checkRun: false }, 7).publish, false);
  });

  test('no pull request in context publishes nothing and passes no --pr', () => {
    assert.deepStrictEqual(action.planGithub(inputs, null), { dryRun: false, publish: false, pr: null });
  });

  test('--agent none through extra-args is a dry run, which the CLI refuses to publish', () => {
    for (const extraArgs of [['--agent', 'none'], ['--agent=none'], ['--fail-on-skip', '--agent', 'none']]) {
      const plan = action.planGithub({ ...inputs, extraArgs }, 7);
      assert.strictEqual(plan.dryRun, true, extraArgs.join(' '));
      assert.strictEqual(plan.publish, false, extraArgs.join(' '));
    }
    assert.strictEqual(action.planGithub({ ...inputs, extraArgs: ['--agent', 'claude'] }, 7).dryRun, false);
  });

  test('the last --agent in extra-args decides, matching how the CLI reads repeated flags', () => {
    assert.strictEqual(action.planGithub({ ...inputs, extraArgs: ['--agent', 'none', '--agent', 'claude'] }, 7).dryRun, false);
  });

  test('a stated base ref needs no lookup, so --pr is only passed to publish', () => {
    const stated = { ...inputs, baseRef: 'origin/release', comment: false, checkRun: false };
    assert.strictEqual(action.planGithub(stated, 7).pr, null);
    assert.strictEqual(action.planGithub({ ...stated, comment: true }, 7).pr, 7);
  });

  test('an unstated base ref passes --pr even when nothing is published, because the CLI resolves the base from it', () => {
    assert.strictEqual(action.planGithub({ ...inputs, comment: false, checkRun: false }, 7).pr, 7);
  });

  test('--files has no base to look up, and the CLI accepts --pr with --files only when publishing', () => {
    const files = { ...inputs, comment: false, checkRun: false, extraArgs: ['--files', 'a.spec.ts'] };
    assert.strictEqual(action.planGithub(files, 7).pr, null);
    assert.strictEqual(action.planGithub({ ...files, comment: true }, 7).pr, 7);
  });
});

describe('teaInstallSource and installCli', () => {
  const PKG = 'bmad-method-test-architecture-enterprise';

  test('a version or dist-tag is an npm spec of the TeA package', () => {
    assert.strictEqual(action.teaInstallSource('1.28.0'), `${PKG}@1.28.0`);
    assert.strictEqual(action.teaInstallSource('next'), `${PKG}@next`);
  });

  test('empty falls back to the default source', () => {
    assert.strictEqual(action.teaInstallSource(''), `${PKG}@${action.DEFAULT_TEA_SOURCE}`);
    assert.strictEqual(action.teaInstallSource(undefined), `${PKG}@${action.DEFAULT_TEA_SOURCE}`);
  });

  test('a tarball URL, a file: spec and a tarball path are used as given', () => {
    for (const source of [
      'https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/releases/download/v1.28.0/tea-1.28.0.tgz',
      'file:../tea.tgz',
      './tea.tgz',
      '/tmp/pack/tea-1.28.0.tgz',
      'tea-1.28.0.tgz',
    ]) {
      assert.strictEqual(action.teaInstallSource(source), source);
    }
  });

  test('installCli installs the CLI source and the agent in one global npm call', () => {
    const calls = [];
    action.installCli('https://example.com/tea.tgz', '@anthropic-ai/claude-code@2.1.220', (command, args) => calls.push([command, args]));
    assert.deepStrictEqual(calls, [
      [action.binaryName('npm'), ['install', '--global', 'https://example.com/tea.tgz', '@anthropic-ai/claude-code@2.1.220']],
    ]);
  });
});

describe('assertCliIsCurrent', () => {
  const helpOf = (stdout) => () => ({ status: 0, stdout });

  test('accepts a CLI whose help lists --github', () => {
    assert.doesNotThrow(() => action.assertCliIsCurrent('next', helpOf('Options:\n  --github  publish to GitHub\n')));
  });

  test('a CLI that predates --github fails with the version to change, not an unknown-option error', () => {
    assert.throws(() => action.assertCliIsCurrent('1.27.2', helpOf('Options:\n  --base <ref>\n')), /1\.27\.2 predates the --github publisher.*tea-version/s);
  });

  test('a package that ships no CLI names the cause instead of a bare ENOENT', () => {
    const missing = () => ({ error: Object.assign(new Error('spawn tea-test-review ENOENT'), { code: 'ENOENT' }) });
    assert.throws(() => action.assertCliIsCurrent('1.5.0', missing), /could not start after installing .*@1\.5\.0.*ships the tea-test-review CLI/s);
  });
});

describe('runReviewCli', () => {
  const setup = () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-review-run-'));
    return {
      workspace,
      opts: { workspace, reportPath: 'review.md', jsonPath: 'review.json', credential: { name: 'TEST_AGENT_KEY', value: 'secret' }, token: 'ghs_t', apiUrl: 'https://api.github.com' },
    };
  };

  test('runs the CLI once, hands it the credential and token, and returns its exit code and verdict', () => {
    const { workspace, opts } = setup();
    let calls = 0;
    try {
      const result = action.runReviewCli(opts, ['--agent', 'claude'], (command, args, options) => {
        calls += 1;
        assert.strictEqual(command, action.binaryName('tea-test-review'));
        assert.deepStrictEqual(args, ['--agent', 'claude']);
        assert.strictEqual(options.cwd, workspace);
        assert.strictEqual(options.env.TEST_AGENT_KEY, 'secret');
        assert.strictEqual(options.env.GITHUB_TOKEN, 'ghs_t');
        fs.writeFileSync(path.join(workspace, 'review.json'), JSON.stringify({ recommendation: 'Approve' }));
        return 0;
      });
      assert.strictEqual(calls, 1);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.verdict.recommendation, 'Approve');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  for (const status of [1, 2, 3]) {
    test(`exit ${status} is passed through and never re-run by the action`, () => {
      const { workspace, opts } = setup();
      let calls = 0;
      try {
        const result = action.runReviewCli(opts, [], () => {
          calls += 1;
          return status;
        });
        assert.strictEqual(calls, 1, 'the CLI owns the retry; the action runs it once');
        assert.strictEqual(result.status, status);
        assert.strictEqual(result.verdict, null);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
  }

  test('a verdict left by an earlier invocation in the job is never read as this run\'s', () => {
    // A dry run followed by a live review share report-path and json-path, and
    // the CLI can exit 2 before writing either.
    const { workspace, opts } = setup();
    fs.writeFileSync(path.join(workspace, 'review.json'), JSON.stringify({ recommendation: 'Approve' }));
    fs.writeFileSync(path.join(workspace, 'review.md'), 'stale');
    try {
      const result = action.runReviewCli(opts, [], () => 2);
      assert.strictEqual(result.verdict, null);
      assert.strictEqual(fs.existsSync(path.join(workspace, 'review.md')), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
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

  test('tea-version falls back to the one DEFAULT_TEA_SOURCE that action.yml also declares', () => {
    assert.strictEqual(action.DEFAULT_TEA_SOURCE, declaredDefault('tea-version'));
    assert.strictEqual(buildWith({ 'INPUT_TEA-VERSION': '' }).teaVersion, action.DEFAULT_TEA_SOURCE);
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
    assert.strictEqual(buildWith({}).baseRef, '');
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
    // And the other direction: an input declared but never read is one that
    // does nothing, which is how a removed feature hides in a wrapper.
    for (const name of declaredInputs()) assert.ok(read.has(name), `main.js never reads input ${name}`);
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
    // The upload step tests == 'true', so 'yes' would name an artifact that is never uploaded.
    assert.strictEqual(buildWith({ 'INPUT_UPLOAD-REPORT': 'yes' }).uploadReport, false);
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
      /if: \$\{\{ \(inputs\.agent == 'codex' \|\| contains\(inputs\.prompt, '@codex'\)\) && runner\.os == 'Linux' && runner\.environment == 'github-hosted' \}\}/,
    );
    // A `@codex` mention can switch to codex from another configured agent, so
    // the step must not depend on inputs.agent alone.
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
    // own output, the same source the --artifact-name flag uses, or the two diverge
    // the moment a mention switches the agent.
    assert.match(ACTION_YML, /name: tea-test-review-\$\{\{ github\.job \}\}-\$\{\{ steps\.review\.outputs\.agent \}\}/);
  });
});

describe('outputsFromVerdict', () => {
  const passing = {
    recommendation: 'Approve',
    qualityScore: 92,
    violations: { critical: 0, high: 1, medium: 2, low: 3 },
    rawQualityScore: 97,
    gateOn: 'introduced',
    reviewMode: 'pr',
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
      'review-mode': 'pr',
      critical: '0',
      high: '0',
      medium: '1',
      low: '0',
      'reviewed-files': '1',
      skipped: 'false',
    });
  });

  test('the score outputs keep their names and read qualityScore and rawQualityScore from the current verdict', () => {
    // TeA #388 removed allFindingsRecommendation. The outputs that read the
    // surviving fields keep working; none ever read the removed one.
    const outputs = action.outputsFromVerdict({ ...passing, gatingQualityScore: 80, qualityScore: 80, rawQualityScore: 85 });
    assert.strictEqual(outputs['quality-score'], '80');
    assert.strictEqual(outputs['full-quality-score'], '80');
    assert.strictEqual(outputs['raw-quality-score'], '85');
    assert.ok(!('all-findings-recommendation' in outputs));
  });

  test('a skipped review reports no score and no recommendation', () => {
    // A skip and a pass both exit 0, so `skipped` is the only way a caller can
    // tell them apart. Reporting 0/100 here would read as a catastrophic review.
    const outputs = action.outputsFromVerdict({ skipped: true, recommendation: null, qualityScore: null, files: [], gateOn: 'all' });
    assert.strictEqual(outputs.skipped, 'true');
    assert.strictEqual(outputs.recommendation, '');
    assert.strictEqual(outputs['quality-score'], '');
    assert.strictEqual(outputs['full-quality-score'], '');
    assert.strictEqual(outputs['raw-quality-score'], '');
    assert.strictEqual(outputs['gate-on'], '');
    assert.strictEqual(outputs['review-mode'], '');
    assert.strictEqual(outputs['reviewed-files'], '0');
  });

  test('a missing verdict yields empty strings and zeros rather than throwing', () => {
    const outputs = action.outputsFromVerdict(null);
    assert.strictEqual(outputs.recommendation, '');
    assert.strictEqual(outputs.critical, '0');
  });

  test('a dry run payload has no verdict fields and maps to empty outputs', () => {
    const outputs = action.outputsFromVerdict({ promptOnly: true, files: ['a.spec.ts'] });
    assert.strictEqual(outputs.recommendation, '');
    assert.strictEqual(outputs['quality-score'], '');
    assert.strictEqual(outputs.skipped, 'false');
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

describe('parseRepository', () => {
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

  test('a trailing slash on the API URL does not double up', async () => {
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => '' };
    };
    await action.addReaction({ ...ctx, apiUrl: 'https://ghe.example/api/v3/' }, 9);
    assert.strictEqual(urls[0], 'https://ghe.example/api/v3/repos/o/r/issues/comments/9/reactions');
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

describe('an existing workflow runs unchanged', { skip: process.platform === 'win32' && 'POSIX stand-in executables' }, () => {
  const MAIN = path.join(__dirname, '..', 'main.js');

  /** A representative value for every input action.yml declares. A new input must be added here. */
  const EVERY_INPUT = {
    mode: 'auto',
    prompt: '@claude @codex',
    agent: 'claude',
    'anthropic-api-key': 'sk-ant-test',
    'claude-code-oauth-token': '',
    'openai-api-key': '',
    'agent-api-key': '',
    'agent-key-env': '',
    'agent-package': '',
    'agent-command': '',
    model: 'opus',
    'agent-args': '--verbose',
    'tea-version': '1.28.0',
    'claude-code-version': '2.1.220',
    'codex-version': 'latest',
    'base-ref': 'origin/release',
    'test-dir': 'tests',
    scope: 'suite',
    'min-score': '80',
    'max-critical': '0',
    'min-files': '1',
    'fail-on': 'block',
    'gate-on': 'introduced',
    'use-playwright-utils': 'true',
    'use-pactjs-utils': 'false',
    'pact-mcp': 'none',
    'extra-args': '--waive "flaky suite" --waive-until 2099-01-01',
    'report-path': 'out/review.md',
    'json-path': 'out/review.json',
    'upload-report': 'true',
    comment: 'true',
    'check-run': 'true',
    'check-run-name': 'Tests',
    'github-token': 'ghs_test_token',
    'github-api-url': 'https://ghe.example/api/v3',
  };

  const VERDICT = {
    recommendation: 'Approve with Comments',
    qualityScore: 88,
    rawQualityScore: 91,
    gatingQualityScore: 88,
    gateOn: 'introduced',
    reviewMode: 'pr',
    gatingViolations: { critical: 0, high: 0, medium: 2, low: 1 },
    reviewedFiles: ['tests/a.spec.ts', 'tests/b.spec.ts'],
  };

  const pullRequestEvent = { pull_request: { number: 7, head: { sha: 'a'.repeat(40) } } };

  /** Stand-ins for `npm`, `codex` and `tea-test-review` that record what they were given. */
  function makeFakeBin(dir) {
    const script = (name, body) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('fs'), path = require('path');\n${body}\n`);
      fs.chmodSync(file, 0o755);
    };
    const record = (fields) => `fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: path.basename(process.argv[1]), argv: process.argv.slice(2), ${fields} }) + '\\n');`;
    script('npm', `${record('')}\nprocess.exit(Number(process.env.FAKE_NPM_EXIT || 0));`);
    script(
      'codex',
      `let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}\n${record('stdin')}`
    );
    script(
      'tea-test-review',
      `const argv = process.argv.slice(2);
if (argv.includes('--help')) { process.stdout.write(process.env.FAKE_HELP || 'Options:\\n  --github  publish\\n'); process.exit(0); }
${record(`env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GITHUB_API_URL: process.env.GITHUB_API_URL, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }, cwd: process.cwd()`)}
if (process.env.FAKE_VERDICT) {
  const json = argv[argv.indexOf('--json') + 1];
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.writeFileSync(json, process.env.FAKE_VERDICT);
}
if (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL);
process.exit(Number(process.env.FAKE_EXIT || 0));`
    );
  }

  /** Run main.js the way the composite action does: INPUT_ variables, GITHUB_ variables, a workspace. */
  async function runAction({ inputs = EVERY_INPUT, event = pullRequestEvent, eventName = 'pull_request', extraEnv = {}, verdict = VERDICT, exit = 0, workspaceSetup } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-review-wiring-'));
    const bin = path.join(root, 'bin');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(bin);
    fs.mkdirSync(workspace);
    makeFakeBin(bin);
    if (workspaceSetup) workspaceSetup(workspace);
    fs.writeFileSync(path.join(root, 'event.json'), JSON.stringify(event));

    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      FAKE_LOG: path.join(root, 'log.jsonl'),
      FAKE_EXIT: String(exit),
      GITHUB_OUTPUT: path.join(root, 'output'),
      GITHUB_EVENT_PATH: path.join(root, 'event.json'),
      GITHUB_EVENT_NAME: eventName,
      GITHUB_WORKSPACE: workspace,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_JOB: 'review',
      GITHUB_RUN_ID: '9',
      ...(verdict ? { FAKE_VERDICT: JSON.stringify(verdict) } : {}),
      ...extraEnv,
    };
    for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;

    // Asynchronous, because the mention scenarios serve a local GitHub API stub
    // from this same process.
    const child = spawn(process.execPath, [MAIN], { env, cwd: workspace });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => child.on('close', resolve));

    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    const calls = read(env.FAKE_LOG)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const outputs = {};
    for (const match of read(env.GITHUB_OUTPUT).matchAll(/^(\S+)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm)) outputs[match[1]] = match[3];
    return { status, stdout, stderr, calls, outputs, workspace, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  const cliCall = (run) => run.calls.find((c) => c.bin === 'tea-test-review');

  test('the fixture sets every input action.yml declares', async () => {
    assert.deepStrictEqual(Object.keys(EVERY_INPUT).sort(), declaredInputs().sort());
  });

  test('every input reaches the CLI as the flag it always meant', async () => {
    const run = await runAction();
    try {
      assert.strictEqual(run.status, 0, run.stdout + run.stderr);
      assert.deepStrictEqual(cliCall(run).argv, [
        '--agent', 'claude',
        '--output', 'out/review.md',
        '--json', 'out/review.json',
        '--retries', '1',
        '--base', 'origin/release',
        '--pr', '7',
        '--github', '--check-name', 'Tests',
        '--artifact-name', 'tea-test-review-review-claude',
        '--model', 'opus',
        '--agent-arg=--verbose',
        '--test-dir', 'tests',
        '--scope', 'suite',
        '--min-score', '80',
        '--max-critical', '0',
        '--min-files', '1',
        '--fail-on', 'block',
        '--gate-on', 'introduced',
        '--use-playwright-utils',
        '--no-use-pactjs-utils',
        '--pact-mcp', 'none',
        '--waive', 'flaky suite',
        '--waive-until', '2099-01-01',
      ]);
    } finally {
      run.cleanup();
    }
  });

  test('the CLI is installed with the agent in one global install at the tea-version, and the CLI runs in the workspace', async () => {
    const run = await runAction();
    try {
      assert.deepStrictEqual(run.calls[0], {
        bin: 'npm',
        argv: ['install', '--global', 'bmad-method-test-architecture-enterprise@1.28.0', '@anthropic-ai/claude-code@2.1.220'],
      });
      assert.strictEqual(fs.realpathSync(cliCall(run).cwd), fs.realpathSync(run.workspace));
      assert.ok(run.calls.findIndex((c) => c.bin === 'tea-test-review') > 0);
    } finally {
      run.cleanup();
    }
  });

  test('the token and API URL travel in the environment, the credential reaches the agent, and none is on argv', async () => {
    const run = await runAction();
    try {
      const call = cliCall(run);
      assert.strictEqual(call.env.GITHUB_TOKEN, 'ghs_test_token');
      assert.strictEqual(call.env.GITHUB_API_URL, 'https://ghe.example/api/v3');
      assert.strictEqual(call.env.ANTHROPIC_API_KEY, 'sk-ant-test');
      assert.ok(!call.argv.join(' ').includes('ghs_test_token'));
      assert.ok(!call.argv.join(' ').includes('sk-ant-test'));
    } finally {
      run.cleanup();
    }
  });

  test('every output is set from the verdict, and the paths are the ones configured', async () => {
    const run = await runAction();
    try {
      assert.deepStrictEqual(run.outputs, {
        agent: 'claude',
        recommendation: 'Approve with Comments',
        'quality-score': '88',
        'full-quality-score': '88',
        'raw-quality-score': '91',
        'gate-on': 'introduced',
        'review-mode': 'pr',
        critical: '0',
        high: '0',
        medium: '2',
        low: '1',
        'reviewed-files': '2',
        skipped: 'false',
        'report-path': 'out/review.md',
        'json-path': 'out/review.json',
      });
    } finally {
      run.cleanup();
    }
  });

  test('every output action.yml declares is one this run sets', async () => {
    const run = await runAction();
    try {
      const outputsSection = ACTION_YML.slice(ACTION_YML.indexOf('\noutputs:'), ACTION_YML.indexOf('\nruns:'));
      for (const name of [...outputsSection.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1])) {
        assert.ok(name in run.outputs, `output ${name} is declared but never set`);
      }
    } finally {
      run.cleanup();
    }
  });

  test('the CLI exit code is the step exit code, and the action runs the CLI once whatever it exits', async () => {
    for (const exit of [1, 2, 3]) {
      const run = await runAction({ exit, verdict: exit === 1 ? VERDICT : null });
      try {
        assert.strictEqual(run.status, exit, `exit ${exit}`);
        assert.strictEqual(run.calls.filter((c) => c.bin === 'tea-test-review').length, 1, 'the CLI owns the retry');
        assert.match(run.stdout, exit === 1 ? /::error::TEA Test Review failed/ : /::error::TEA Test Review did not produce a verdict.*broken gate/);
      } finally {
        run.cleanup();
      }
    }
  });

  test('a CLI that exits before writing a verdict leaves outputs empty rather than stale', async () => {
    const run = await runAction({
      exit: 2,
      verdict: null,
      workspaceSetup: (workspace) => {
        fs.mkdirSync(path.join(workspace, 'out'));
        fs.writeFileSync(path.join(workspace, 'out', 'review.json'), JSON.stringify({ recommendation: 'Approve' }));
      },
    });
    try {
      assert.strictEqual(run.status, 2);
      assert.strictEqual(run.outputs.recommendation, '');
      assert.strictEqual(run.outputs.critical, '0');
    } finally {
      run.cleanup();
    }
  });

  test('comment false and check-run false publish nothing and keep the base ref lookup off the API', async () => {
    const run = await runAction({ inputs: { ...EVERY_INPUT, comment: 'false', 'check-run': 'false' } });
    try {
      const argv = cliCall(run).argv;
      for (const flag of ['--github', '--pr', '--check-name', '--artifact-name']) assert.ok(!argv.includes(flag), `${flag} should be absent`);
      assert.strictEqual(argv[argv.indexOf('--base') + 1], 'origin/release');
    } finally {
      run.cleanup();
    }
  });

  test('comment false with check-run on keeps the check run only, and the reverse keeps the comment only', async () => {
    const noComment = await runAction({ inputs: { ...EVERY_INPUT, comment: 'false' } });
    const noCheck = await runAction({ inputs: { ...EVERY_INPUT, 'check-run': 'false' } });
    try {
      assert.ok(cliCall(noComment).argv.includes('--no-pr-comment'));
      assert.ok(!cliCall(noComment).argv.includes('--no-check-run'));
      assert.ok(cliCall(noCheck).argv.includes('--no-check-run'));
      assert.ok(!cliCall(noCheck).argv.includes('--no-pr-comment'));
    } finally {
      noComment.cleanup();
      noCheck.cleanup();
    }
  });

  test('upload-report false names no artifact, so the comment promises none', async () => {
    const run = await runAction({ inputs: { ...EVERY_INPUT, 'upload-report': 'false' } });
    try {
      assert.ok(!cliCall(run).argv.includes('--artifact-name'));
    } finally {
      run.cleanup();
    }
  });

  test('a custom vendor runs as claude under its own executable, with its credential allowlisted', async () => {
    const inputs = {
      ...EVERY_INPUT,
      agent: 'gemini',
      'anthropic-api-key': '',
      'agent-package': '@google/gemini-cli@0.5.0',
      'agent-command': 'gemini',
      'agent-key-env': 'GEMINI_API_KEY',
      'agent-api-key': 'gem-test',
      model: '',
      'agent-args': '',
    };
    const run = await runAction({ inputs });
    try {
      assert.strictEqual(run.status, 0, run.stdout + run.stderr);
      assert.deepStrictEqual(run.calls[0].argv, ['install', '--global', 'bmad-method-test-architecture-enterprise@1.28.0', '@google/gemini-cli@0.5.0']);
      const argv = cliCall(run).argv;
      assert.deepStrictEqual(argv.slice(0, 2), ['--agent', 'claude']);
      assert.strictEqual(argv[argv.indexOf('--agent-cmd') + 1], 'gemini');
      assert.strictEqual(argv[argv.indexOf('--env-pass') + 1], 'GEMINI_API_KEY');
      assert.strictEqual(argv[argv.indexOf('--artifact-name') + 1], 'tea-test-review-review-gemini');
      assert.match(run.stdout, /::warning::Agent "gemini" is not a built-in vendor/);
      assert.strictEqual(run.outputs.agent, 'gemini');
    } finally {
      run.cleanup();
    }
  });

  test('tea-version also takes a tarball URL, installed as given', async () => {
    const url = 'https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/releases/download/v1.28.0/tea-1.28.0.tgz';
    const run = await runAction({ inputs: { ...EVERY_INPUT, 'tea-version': url } });
    try {
      assert.deepStrictEqual(run.calls[0].argv.slice(0, 3), ['install', '--global', url]);
    } finally {
      run.cleanup();
    }
  });

  test('a failed install stops the run before the CLI and exits 2', async () => {
    const run = await runAction({ extraEnv: { FAKE_NPM_EXIT: '1' } });
    try {
      assert.strictEqual(run.status, 2);
      assert.strictEqual(cliCall(run), undefined);
      assert.match(run.stdout, /::error::.*npm.*exited with code 1/);
    } finally {
      run.cleanup();
    }
  });

  test('an event that does not trigger the review is a clean skip: exit 0, skipped=true, nothing installed', async () => {
    const run = await runAction({ inputs: { ...EVERY_INPUT, mode: 'manual' } });
    try {
      assert.strictEqual(run.status, 0);
      assert.deepStrictEqual(run.outputs, { skipped: 'true' });
      assert.deepStrictEqual(run.calls, []);
      assert.match(run.stdout, /::notice::TEA Test Review not triggered/);
    } finally {
      run.cleanup();
    }
  });

  test('a CLI killed by a signal is a broken gate, not a pass and not a verdict', async () => {
    const run = await runAction({ verdict: null, extraEnv: { FAKE_SIGNAL: 'SIGKILL' } });
    try {
      assert.strictEqual(run.status, 3);
      assert.match(run.stdout, /terminated by SIGKILL/);
      assert.match(run.stdout, /did not produce a verdict/);
    } finally {
      run.cleanup();
    }
  });

  test('neither the GitHub token nor the agent credential appears in the log', async () => {
    const run = await runAction();
    try {
      assert.ok(!(run.stdout + run.stderr).includes('ghs_test_token'));
      assert.ok(!(run.stdout + run.stderr).includes('sk-ant-test'));
    } finally {
      run.cleanup();
    }
  });

  test('a waived verdict failure passes with a notice naming the reason', async () => {
    const run = await runAction({ verdict: { ...VERDICT, waived: true, waiveReason: 'FP-1' } });
    try {
      assert.strictEqual(run.status, 0);
      assert.match(run.stdout, /::notice::Verdict failure waived: FP-1/);
    } finally {
      run.cleanup();
    }
  });

  test('an absolute json-path is read where the CLI wrote it', async () => {
    const abs = path.join(os.tmpdir(), `tea-wiring-abs-${process.pid}.json`);
    const run = await runAction({ inputs: { ...EVERY_INPUT, 'json-path': abs } });
    try {
      assert.strictEqual(run.outputs.recommendation, 'Approve with Comments');
    } finally {
      fs.rmSync(abs, { force: true });
      run.cleanup();
    }
  });

  test('upload-report other than true names no artifact, because the upload step would skip', async () => {
    const run = await runAction({ inputs: { ...EVERY_INPUT, 'upload-report': 'yes' } });
    try {
      assert.ok(!cliCall(run).argv.includes('--artifact-name'));
    } finally {
      run.cleanup();
    }
  });

  test('a dry run through extra-args reviews nothing and publishes nothing', async () => {
    const run = await runAction({ inputs: { ...EVERY_INPUT, 'extra-args': '--agent none' }, verdict: { promptOnly: true, files: ['tests/a.spec.ts'] } });
    try {
      assert.strictEqual(run.status, 0, run.stdout);
      const argv = cliCall(run).argv;
      assert.ok(!argv.includes('--github'));
      assert.ok(!argv.includes('--model'), 'the CLI rejects --model with --agent none');
      assert.deepStrictEqual(argv.slice(-2), ['--agent', 'none']);
      assert.match(run.stdout, /::notice::extra-args select --agent none/);
    } finally {
      run.cleanup();
    }
  });

  test('a skipped review is a pass with skipped=true and empty scores', async () => {
    const run = await runAction({ verdict: { skipped: true, reason: 'no changed test files in diff', recommendation: null, qualityScore: null, files: [], gateOn: 'all' } });
    try {
      assert.strictEqual(run.status, 0);
      assert.strictEqual(run.outputs.skipped, 'true');
      assert.strictEqual(run.outputs['quality-score'], '');
      assert.match(run.stdout, /::notice::Review skipped/);
    } finally {
      run.cleanup();
    }
  });

  test('a tea-version whose CLI predates --github stops before the review with the version to change', async () => {
    const run = await runAction({ extraEnv: { FAKE_HELP: 'Options:\n  --base <ref>\n' } });
    try {
      assert.strictEqual(run.status, 2);
      assert.strictEqual(cliCall(run), undefined, 'the review must not start');
      assert.match(run.stdout, /::error::bmad-method-test-architecture-enterprise@1\.28\.0 predates the --github publisher/);
    } finally {
      run.cleanup();
    }
  });

  test('a push run has no pull request, so it publishes nothing and leaves the base to the CLI', async () => {
    const run = await runAction({
      inputs: { ...EVERY_INPUT, 'base-ref': '' },
      eventName: 'push',
      event: { ref: 'refs/heads/main' },
      extraEnv: { GITHUB_REF: 'refs/heads/main' },
    });
    try {
      const argv = cliCall(run).argv;
      for (const flag of ['--github', '--pr', '--base']) assert.ok(!argv.includes(flag), `${flag} should be absent`);
    } finally {
      run.cleanup();
    }
  });

  test('a pull_request into a release branch states that base, so no API lookup is needed', async () => {
    const run = await runAction({ inputs: { ...EVERY_INPUT, 'base-ref': '' }, extraEnv: { GITHUB_BASE_REF: 'release/2.0' } });
    try {
      const argv = cliCall(run).argv;
      assert.strictEqual(argv[argv.indexOf('--base') + 1], 'origin/release/2.0');
    } finally {
      run.cleanup();
    }
  });

  describe('a mention comment', () => {
    const commentEvent = {
      issue: { number: 7, pull_request: {} },
      comment: { id: 55, body: '@codex look hard at the retry paths', author_association: 'MEMBER', user: { type: 'User' } },
    };

    /** A local stand-in for the GitHub API, recording the reaction POST. */
    async function withGithubStub(fn) {
      const requests = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end('{}');
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await fn(`http://127.0.0.1:${server.address().port}`, requests);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    test('reacts with :eyes:, switches to the mentioned agent, logs it in, and asks the CLI to resolve the base from the PR', async () => {
      await withGithubStub(async (apiUrl, requests) => {
        const inputs = {
          ...EVERY_INPUT,
          'base-ref': '',
          'openai-api-key': 'sk-openai-test',
          'anthropic-api-key': '',
          'github-api-url': apiUrl,
          model: 'opus',
          'agent-args': '--verbose',
        };
        const run = await runAction({ inputs, event: commentEvent, eventName: 'issue_comment' });
        try {
          assert.strictEqual(run.status, 0, run.stdout + run.stderr);
          assert.deepStrictEqual(
            requests.map((r) => [r.method, r.url, r.auth, r.body]),
            [['POST', '/repos/o/r/issues/comments/55/reactions', 'bearer ghs_test_token', '{"content":"eyes"}']]
          );
          const order = run.calls.map((c) => c.bin);
          assert.deepStrictEqual(order, ['npm', 'codex', 'tea-test-review']);
          const login = run.calls.find((c) => c.bin === 'codex');
          assert.deepStrictEqual(login.argv, ['login', '--with-api-key']);
          assert.strictEqual(login.stdin, 'sk-openai-test\n');
          const argv = cliCall(run).argv;
          assert.strictEqual(argv[argv.indexOf('--agent') + 1], 'codex');
          assert.strictEqual(argv[argv.indexOf('--pr') + 1], '7');
          assert.ok(!argv.includes('--base'), 'the CLI resolves the base from --pr');
          assert.strictEqual(argv[argv.indexOf('--focus') + 1], 'look hard at the retry paths');
          assert.ok(!argv.includes('--model'), 'a vendor switch resets the per-vendor model');
          assert.ok(!argv.includes('--agent-arg=--verbose'), 'a vendor switch resets agent-args');
          assert.strictEqual(argv[argv.indexOf('--artifact-name') + 1], 'tea-test-review-review-codex');
          assert.strictEqual(run.outputs.agent, 'codex');
        } finally {
          run.cleanup();
        }
      });
    });
  });
});

