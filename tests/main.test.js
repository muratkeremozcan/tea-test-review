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
      'codex 0.146.0 authenticates only from ~/.codex/auth.json, which no runner has'
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
  test('claude is built in and pins from claude-code-version', () => {
    const agent = action.resolveAgent({ agent: 'claude', agentVersions: { claude: '2.1.220' } });
    assert.strictEqual(agent.key, 'claude');
    assert.strictEqual(agent.cliAgent, 'claude', 'a known vendor is passed straight through as --agent');
    assert.strictEqual(agent.packageSpec, '@anthropic-ai/claude-code@2.1.220');
    assert.strictEqual(agent.command, 'claude');
    assert.strictEqual(agent.verified, true);
    // Both claude variables are already in the CLI's BASE_ENV_NAMES.
    assert.strictEqual(agent.needsEnvPass, false);
    assert.deepStrictEqual(agent.credentialEnvNames, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  test('codex is built in and pins from codex-version', () => {
    // Second built-in vendor, proven live against a real test file by the
    // review CLI's own cli/lib/agent-adapters.js (codex exec --sandbox
    // workspace-write), not just plumbed through --agent-cmd.
    const agent = action.resolveAgent({ agent: 'codex', agentVersions: { codex: '0.146.0' } });
    assert.strictEqual(agent.key, 'codex');
    assert.strictEqual(agent.cliAgent, 'codex');
    assert.strictEqual(agent.packageSpec, '@openai/codex@0.146.0');
    assert.strictEqual(agent.command, 'codex');
    assert.strictEqual(agent.verified, true);
    // Already covered by the CLI's own codex adapter envNames, same as claude.
    assert.strictEqual(agent.needsEnvPass, false);
    assert.deepStrictEqual(agent.credentialEnvNames, ['OPENAI_API_KEY']);
  });

  test('an empty agent defaults to claude', () => {
    assert.strictEqual(action.resolveAgent({ agent: '', agentVersions: { claude: '2.1.220' } }).key, 'claude');
    assert.strictEqual(action.resolveAgent({ agentVersions: { claude: '2.1.220' } }).key, 'claude');
  });

  test('agent-package overrides the built-in spec', () => {
    const agent = action.resolveAgent({
      agent: 'claude',
      agentPackage: '@anthropic-ai/claude-code@2.0.0',
      agentVersions: { claude: '2.1.220' },
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
  const claude = action.resolveAgent({ agent: 'claude', agentVersions: { claude: '2.1.220' } });

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
    const codex = action.resolveAgent({ agent: 'codex', agentVersions: { codex: '0.146.0' } });
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
    });
    for (const flag of ['--test-dir', '--scope', '--min-score', '--max-critical', '--min-files', '--fail-on']) {
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
      testDir: 'test',
      scope: 'directory',
    });
    for (const [flag, value] of [
      ['--min-score', '80'],
      ['--max-critical', '0'],
      ['--min-files', '2'],
      ['--fail-on', 'block'],
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

  test('claude-code-version', () => {
    assert.strictEqual(buildWith({}).agent.packageSpec, `@anthropic-ai/claude-code@${declaredDefault('claude-code-version')}`);
  });

  test('codex-version', () => {
    const opts = action.buildOptions({ INPUT_AGENT: 'codex', 'INPUT_OPENAI-API-KEY': 'sk-test' });
    assert.strictEqual(opts.agent.packageSpec, `@openai/codex@${declaredDefault('codex-version')}`);
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

  test('agent-args are parsed as a shell-style argument list', () => {
    const opts = buildWith({ 'INPUT_AGENT-ARGS': '-c "model_reasoning_effort=low"' });
    assert.deepStrictEqual(opts.cli.agentArgs, ['-c', 'model_reasoning_effort=low']);
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
    assert.ok(read.size >= 18, `expected the full input surface, saw ${read.size}`);
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
    assert.ok(declared.length >= 25, `expected the full input surface, saw ${declared.length}`);
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
    assert.match(ACTION_YML, /name: tea-test-review-\$\{\{ github\.job \}\}/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(source, /tea-test-review-\$\{env\.GITHUB_JOB\}/);
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
    reviewedFiles: ['tests/checkout.spec.ts'],
  };

  test('a passing verdict maps every field', () => {
    assert.deepStrictEqual(action.outputsFromVerdict(passing), {
      recommendation: 'Approve',
      'quality-score': '92',
      critical: '0',
      high: '1',
      medium: '2',
      low: '3',
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
    violations: { critical: 1, high: 2, medium: 3, low: 4 },
    reviewedFiles: ['tests/checkout.spec.ts', 'tests/cart.spec.ts'],
    keyWeaknesses: ['first', 'second', 'third', 'fourth'],
  };

  test('carries the marker, so the next push updates this comment instead of adding one', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.ok(body.startsWith(action.COMMENT_MARKER));
  });

  test('the digest states score, recommendation, violations and reviewed-file count', () => {
    const body = action.buildCommentBody({ verdict, reportText: '# report', runUrl });
    assert.match(body, /## TEA Test Review: Request Changes/);
    assert.match(body, /\*\*Quality score\*\*: 64\/100/);
    assert.match(body, /\*\*Violations\*\*: 1 Critical \/ 2 High \/ 3 Medium \/ 4 Low/);
    assert.match(body, /\*\*Reviewed files\*\*: 2/);
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
    assert.match(body, /- first/);
    assert.match(body, /- third/);
    assert.ok(!body.includes('- fourth'));
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
    assert.match(body, /\*\*Quality score\*\*: 64\/100/);
    assert.match(body, /not readable from the workspace/);
  });

  test('a skipped review says so, and claims no verdict', () => {
    const body = action.buildCommentBody({
      verdict: { skipped: true, reason: 'no changed test files in diff' },
      runUrl,
    });
    assert.match(body, /## TEA Test Review: skipped/);
    assert.match(body, /no changed test files in diff\./);
    assert.ok(!body.includes('Quality score'));
  });

  test('a skip with no reason still reads as a skip', () => {
    const body = action.buildCommentBody({ verdict: { skipped: true }, runUrl });
    assert.match(body, /No changed test files in this PR\./);
  });

  test('an --agent none dry run says no review happened, rather than a verdict of undefined', () => {
    // Reachable through extra-args, and the payload has no recommendation at all.
    const body = action.buildCommentBody({ verdict: { promptOnly: true, files: ['tests/a.spec.ts'] }, runUrl });
    assert.match(body, /## TEA Test Review: no review performed/);
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
    assert.match(body, /## TEA Test Review: infrastructure failure/);
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
    assert.match(body, /\*\*Violations\*\*: 0 Critical \/ 0 High \/ 0 Medium \/ 0 Low/);
    assert.ok(!body.includes('undefined'));
  });
});

describe('findOwnComment', () => {
  test('finds the comment carrying the marker', () => {
    const found = action.findOwnComment([
      { id: 1, body: 'unrelated review note' },
      { id: 2, body: `${action.COMMENT_MARKER}\n## TEA Test Review: Approve` },
    ]);
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
