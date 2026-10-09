'use strict';

/**
 * TEA Test Review: the GitHub Actions wrapper around the `tea-test-review` CLI.
 *
 * The CLI owns the review: the packaged skill, the retry, the pull request base
 * lookup, the comment and its upsert, and the check run. This file owns what only
 * a GitHub Actions run can know: INPUT_ variables, step outputs, the mention
 * trigger and its trusted-author gate, the :eyes: reaction, and installing and
 * logging in the agent CLI. It turns those into one CLI call and passes the CLI's
 * exit code through. A verdict (exit 1) and a broken gate (exit 2, 3) stay
 * distinct, and no path here turns a non-zero exit into a pass.
 *
 * Zero dependencies on purpose: no node_modules to audit, no bundle step, and no
 * third-party JavaScript between a pull request and the check that blocks it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── workflow command helpers (replaces @actions/core, which would need deps) ──

/** Mirrors @actions/core's lookup: uppercase, spaces to underscores, dashes kept (`github-token` reads INPUT_GITHUB-TOKEN). */
function getInput(name, env = process.env) {
  const raw = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return raw == null ? '' : String(raw).trim();
}

function getBooleanInput(name, env = process.env) {
  const raw = getInput(name, env).toLowerCase();
  if (raw === '') return false;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`input ${name} must be a boolean, got "${raw}"`);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try {
    // Delimiter form, as @actions/core: `name=value` lets a newline in a value
    // inject further outputs, and one value comes from an agent-written report.
    const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
    fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } catch {
    /* a lost output must not fail the gate */
  }
}

const log = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => log(`::warning::${msg}`);
const notice = (msg) => log(`::notice::${msg}`);

// ─── constants ────────────────────────────────────────────────────────────────

const TEA_PACKAGE = 'bmad-method-test-architecture-enterprise';

/**
 * Where the CLI is installed from when tea-version is empty. action.yml declares
 * the same value and a test pins the two together.
 */
const DEFAULT_TEA_SOURCE = 'latest';

/** The CLI's exit codes, which this action passes through unchanged. */
const EXIT_MEANING = {
  0: 'review passed, was skipped, or a verdict failure was waived',
  1: 'review verdict failure',
  2: 'environment or configuration error, so the gate did not run',
  3: 'agent or report-parse failure, so there is no verdict',
};

/**
 * Extra attempts after an agent or report-parse failure (exit 3), handed to the
 * CLI's --retries. Stated rather than left to the CLI's CI default so the count
 * does not depend on whether the runner sets CI; extra-args can override it.
 */
const CLI_RETRIES = 1;

/**
 * Vendors proven by a live run. `credentialInputs` is positional against
 * `credentialEnvNames`. An unknown `agent` resolves through agent-package,
 * agent-command and agent-key-env and runs as claude's protocol under
 * --agent-cmd, so it must accept claude's argv and a stdin prompt or the run
 * fails inside the CLI as exit 3.
 */
const AGENTS = {
  claude: {
    package: '@anthropic-ai/claude-code',
    command: 'claude',
    // API key bills per token; the OAuth token (`claude setup-token`) bills a subscription.
    credentialEnvNames: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    credentialInputs: ['anthropicApiKey', 'claudeCodeOauthToken'],
    // In the CLI's minimal agent environment already.
    needsEnvPass: false,
  },
  codex: {
    package: '@openai/codex',
    command: 'codex',
    credentialEnvNames: ['OPENAI_API_KEY'],
    credentialInputs: ['openaiApiKey'],
    needsEnvPass: false,
    // codex ignores OPENAI_API_KEY and reads only ~/.codex/auth.json, which no
    // runner has ("Missing bearer or basic authentication in header"). This
    // writes the file first, with the key on stdin so it stays out of the log.
    loginArgv: ['login', '--with-api-key'],
  },
};

// ─── pure logic, exported for tests ───────────────────────────────────────────

/** npm-installed executables are `.cmd` shims on Windows, and spawn without a shell will not find them. */
function binaryName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.cmd` : name;
}

/** The base ref the caller or the event states, or '' to let the CLI resolve it from `--pr` (an issue_comment event carries none). */
function resolveBaseRef(raw, env = process.env) {
  const explicit = String(raw == null ? '' : raw).trim();
  if (explicit !== '') return explicit;
  const base = String(env.GITHUB_BASE_REF || '').trim();
  return base ? `origin/${base}` : '';
}

/**
 * The argument `npm install` takes for a tea-version value. A tarball URL, a
 * `file:` spec or a path to a tarball is used as given; anything else is an npm
 * version or dist-tag of the TeA package. The one place that knows where the CLI
 * comes from, so moving the default source is a change to this function.
 */
function teaInstallSource(source) {
  const value = String(source == null ? '' : source).trim() || DEFAULT_TEA_SOURCE;
  const isTarball = /^(https?|file):/i.test(value) || /^(\.{0,2}\/|~\/)/.test(value) || /\.(tgz|tar\.gz)$/i.test(value);
  return isTarball ? value : `${TEA_PACKAGE}@${value}`;
}

/** '' means "leave the CLI's own resolution alone", which is not the same as false. */
function parseTriState(raw, name) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (value === '') return null;
  if (['true', '1', 'yes'].includes(value)) return true;
  if (['false', '0', 'no'].includes(value)) return false;
  throw new Error(`input ${name} must be 'true', 'false' or empty, got "${raw}"`);
}

function parsePactMcp(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value === '') return null;
  if (!['mcp', 'none'].includes(value)) {
    throw new Error(`input pact-mcp must be 'mcp', 'none' or empty, got "${raw}"`);
  }
  return value;
}

/** Split an argument-list input like a shell would, honouring quotes. Not a shell: tokens go into an argv array, so nothing interpolates. */
function parseExtraArgs(raw, inputName = 'extra-args') {
  const text = String(raw == null ? '' : raw);
  const token = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const stray = /["']/.exec(text.replace(token, ''))?.[0];
  if (stray) throw new Error(`${inputName} has an unterminated ${stray === '"' ? 'double' : 'single'} quote`);
  return (text.match(token) || []).map((t) => t.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
}

/** The last value extra-args gives a flag, in `--flag value` or `--flag=value` form; undefined when absent. */
function extraArgValue(extraArgs, flag) {
  let value;
  extraArgs.forEach((arg, i) => {
    if (arg === flag) value = extraArgs[i + 1];
    else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
  });
  return value;
}

const hasExtraFlag = (extraArgs, flag) => extraArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`));

/**
 * The key as a tag the CLI's comment marker and an artifact name can carry. The
 * `agent` input is free text (`@acme/reviewer`); the CLI refuses a `--publish-as`
 * outside letters, digits, dots, dashes and underscores, and upload-artifact
 * refuses a `/`. A tag that would land on a built-in's name is prefixed so a
 * custom vendor never shares claude's or codex's comment.
 */
function agentTag(key) {
  let tag = String(key).replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (!tag || Object.hasOwn(AGENTS, tag)) tag = `custom-${tag || 'agent'}`;
  return tag;
}

/**
 * Resolve the vendor into an install spec, an executable, a credential variable
 * and the `--agent` value the CLI understands (`cliAgent`). They diverge once:
 * an unknown vendor is not in the CLI's adapter table, so it runs as claude's
 * protocol via `--agent-cmd`.
 */
function resolveAgent({ agent, agentPackage, agentCommand, agentKeyEnv, agentVersions = {} }) {
  const key = String(agent == null ? '' : agent).trim() || 'claude';
  const known = AGENTS[key];

  if (known) {
    // An empty version falls back to the bare name, never a spec ending in `@`.
    const version = agentVersions[key];
    const packageSpec = agentPackage || (version ? `${known.package}@${version}` : known.package);
    return {
      key,
      tag: key,
      cliAgent: key,
      verified: true,
      packageSpec,
      command: agentCommand || known.command,
      credentialEnvNames: known.credentialEnvNames,
      credentialInputs: known.credentialInputs,
      needsEnvPass: known.needsEnvPass,
      loginArgv: known.loginArgv,
    };
  }

  if (!agentPackage) {
    throw new Error(
      `agent "${key}" is not built in, so agent-package is required (an npm spec with an exact version, e.g. '@google/gemini-cli@0.5.0'). ` +
        `Built-in agents: ${Object.keys(AGENTS).join(', ')}.`
    );
  }
  if (!agentKeyEnv) {
    throw new Error(
      `agent "${key}" is not built in, so agent-key-env is required: the review CLI hands the agent a minimal environment ` +
        'and drops every variable it was not told to pass, so an unnamed credential never reaches the agent.'
    );
  }
  return {
    key,
    tag: agentTag(key),
    cliAgent: 'claude',
    verified: false,
    packageSpec: agentPackage,
    command: agentCommand || key,
    credentialEnvNames: [agentKeyEnv],
    // Only the built-in vendors' variables are in the CLI's allowlist.
    needsEnvPass: true,
  };
}

/**
 * Pick the credential to inject, an explicit input over the step's own `env:`.
 * None is null, with a warning, rather than an error: the CLI checks that the
 * agent is installed and logged in before it spends anything, exits 2 with the
 * remedy when it is not, and publishes that to the pull request, which an
 * error thrown here could not. A stored login (a self-hosted runner) still works.
 */
function resolveCredential(inputs, agent, env = process.env) {
  const candidates = agent.verified
    ? agent.credentialEnvNames.map((name, i) => [name, inputs[agent.credentialInputs[i]]])
    : [[agent.credentialEnvNames[0], inputs.agentApiKey]];

  const supplied = candidates.filter(([, value]) => value);
  if (supplied.length > 1) {
    warn(
      `Both ${supplied.map(([name]) => name).join(' and ')} were supplied. Using ${supplied[0][0]}; ` +
        'set exactly one so it is obvious which account a run bills against.'
    );
  }
  if (supplied.length > 0) return { name: supplied[0][0], value: supplied[0][1] };

  const fromEnv = agent.credentialEnvNames.find((name) => env[name]);
  if (fromEnv) return { name: fromEnv, value: env[fromEnv] };

  warn(
    `no credential for the ${agent.key} agent: set one of ${agent.credentialEnvNames.join(' or ')}, ` +
      'as an input or in the step\'s env. Fork pull requests receive no secrets, so guard this job with ' +
      "`if: github.event.pull_request.head.repo.full_name == github.repository` on the caller's side. " +
      'The review stops, as a published broken gate, unless the agent is already logged in.'
  );
  return null;
}

/**
 * The environment the review CLI runs in. HOME, USER and LOGNAME are
 * load-bearing: without USER neither claude nor codex can read stored
 * credentials. GITHUB_TOKEN and GITHUB_API_URL tell the CLI where and as whom
 * to publish; the CLI reads the token from the environment only, so it never
 * reaches a command line, and its agent environment is an allowlist without it.
 */
function childEnv(credential, env = process.env, userInfo = os.userInfo(), github = {}) {
  const out = { ...env };
  if (credential) out[credential.name] = credential.value;
  if (github.token) out.GITHUB_TOKEN = github.token;
  if (github.apiUrl) out.GITHUB_API_URL = github.apiUrl;
  if (!out.HOME) out.HOME = userInfo.homedir;
  if (!out.USER) out.USER = userInfo.username;
  if (!out.LOGNAME) out.LOGNAME = out.USER;
  return out;
}

/**
 * What to hand the CLI about GitHub. `publish` turns on --github when a pull
 * request is in context, unless extra-args select `--agent none`: the CLI
 * refuses to publish a review that never ran. `pr` is passed to publish, or to
 * look up the base branch an issue_comment event lacks; a stated base ref needs
 * no lookup, and a --files review has no base.
 */
function planGithub({ comment, checkRun, baseRef, extraArgs = [] }, prNumber) {
  const dryRun = extraArgValue(extraArgs, '--agent') === 'none';
  const publish = (comment || checkRun) && !dryRun && prNumber != null;
  const needsLookup = baseRef === '' && !hasExtraFlag(extraArgs, '--files');
  return { dryRun, publish, pr: prNumber != null && (publish || needsLookup) ? prNumber : null };
}

/**
 * Build the tea-test-review argv. There is no --skill-root: the CLI reviews with
 * its packaged skill, out of the pull request's reach and of one version with
 * the CLI. `model` is forwarded only when set; the CLI pins a default per vendor.
 */
function buildCliArgs(opts) {
  const args = ['--agent', opts.cliAgent, '--output', opts.reportPath, '--json', opts.jsonPath, '--retries', String(CLI_RETRIES)];
  const valued = (pairs) => pairs.forEach(([flag, value]) => value && args.push(flag, value));
  const triState = (value, on, off) => value !== null && value !== undefined && args.push(value ? on : off);

  valued([['--base', opts.baseRef], ['--pr', opts.pr != null && String(opts.pr)]]);
  if (opts.publish) {
    args.push('--github', '--check-name', opts.checkRunName);
    if (!opts.comment) args.push('--no-pr-comment');
    if (!opts.checkRun) args.push('--no-check-run');
    valued([
      ['--artifact-name', opts.artifactName],
      ['--publish-as', opts.publishAs],
    ]);
  }
  if (opts.agentCommand !== opts.cliAgent) args.push('--agent-cmd', opts.agentCommand);
  valued([
    ['--env-pass', opts.envPass],
    // The CLI rejects --model with --agent none, which runs no agent.
    ['--model', !opts.dryRun && opts.model],
  ]);
  for (const arg of opts.agentArgs || []) args.push(`--agent-arg=${arg}`);
  valued([
    ['--test-dir', opts.testDir],
    ['--scope', opts.scope],
    ['--focus', opts.focus],
    ['--min-score', opts.minScore],
    ['--max-critical', opts.maxCritical],
    ['--min-files', opts.minFiles],
    ['--fail-on', opts.failOn],
    ['--gate-on', opts.gateOn],
  ]);
  triState(opts.usePlaywrightUtils, '--use-playwright-utils', '--no-use-playwright-utils');
  triState(opts.usePactjsUtils, '--use-pactjs-utils', '--no-use-pactjs-utils');
  valued([['--pact-mcp', opts.pactMcp]]);

  return [...args, ...(opts.extraArgs || [])];
}

/**
 * Verdict fields to step outputs; a skipped review has nulls, not zeros.
 * `full-quality-score` and `raw-quality-score` read `qualityScore` and
 * `rawQualityScore`. In `pr` review mode the verdict carries only the pull
 * request's own findings, and in `full-file` mode every finding gates, so these
 * equal the gating values; the outputs keep their names for existing workflows.
 * The verdict no longer carries a recommendation over all findings
 * (`allFindingsRecommendation`), and no output ever exposed it.
 */
function outputsFromVerdict(verdict) {
  const v = verdict || {};
  const counts = v.gatingViolations || v.violations || {};
  const skipped = v.skipped === true;
  const gatingQualityScore = v.gatingQualityScore ?? v.qualityScore;
  return {
    recommendation: skipped || v.recommendation == null ? '' : String(v.recommendation),
    'quality-score': skipped || gatingQualityScore == null ? '' : String(gatingQualityScore),
    'full-quality-score': skipped || v.qualityScore == null ? '' : String(v.qualityScore),
    'raw-quality-score': skipped || v.rawQualityScore == null ? '' : String(v.rawQualityScore),
    'gate-on': skipped ? '' : String(v.gateOn ?? ''),
    'review-mode': skipped || v.reviewMode == null ? '' : String(v.reviewMode),
    critical: String(counts.critical ?? 0),
    high: String(counts.high ?? 0),
    medium: String(counts.medium ?? 0),
    low: String(counts.low ?? 0),
    'reviewed-files': String((v.reviewedFiles || []).length),
    skipped: skipped ? 'true' : 'false',
  };
}

/** Pull request number from the event payload, falling back to refs/pull/N/merge. */
function resolvePrNumber(payload, env = process.env) {
  const fromPayload = payload?.pull_request?.number ?? payload?.issue?.number;
  if (Number.isInteger(fromPayload)) return fromPayload;
  const match = /^refs\/pull\/(\d+)\//.exec(String(env.GITHUB_REF || ''));
  return match ? Number(match[1]) : null;
}

function parseRepository(env = process.env) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  return owner && repo ? { owner, repo } : null;
}

// ─── IO ───────────────────────────────────────────────────────────────────────

/**
 * Run a command with its output streamed straight through: the CLI prints a
 * heartbeat every 15 seconds because a real review takes minutes, and capturing
 * stdout would make the job look hung.
 */
function runCommand(command, args, options = {}) {
  log(`+ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(`${command} not found on PATH`);
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  // A command killed by a signal has no exit status: that is a gate that did not run (3), never a verdict (1).
  if (result.status == null) {
    warn(`${command} was terminated by ${result.signal || 'a signal'}.`);
    return 3;
  }
  return result.status;
}

function runCommandChecked(command, args, options = {}) {
  const status = runCommand(command, args, options);
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${status}`);
}

/** Install the CLI from its source (see teaInstallSource) and the agent CLI, globally, in one npm call so the CLI resolves once. */
function installCli(source, agentSpec, runner = runCommandChecked) {
  runner(binaryName('npm'), ['install', '--global', teaInstallSource(source), agentSpec]);
}

/**
 * Write the agent's credential to its on-disk auth store, for vendors that
 * refuse the environment (codex today; a no-op without a loginArgv or without a
 * credential). stdio is piped and the key goes through stdin, so it reaches
 * neither the log nor a process list. A login that fails is a warning, not an
 * error: the CLI then finds the agent logged out or missing, exits 2 with the
 * remedy, and publishes that as a broken gate.
 */
function agentLogin(agent, credential) {
  if (!agent.loginArgv || !credential) return;
  log(`+ ${agent.command} ${agent.loginArgv.join(' ')} (credential on stdin)`);
  const result = spawnSync(binaryName(agent.command), agent.loginArgv, {
    input: `${credential.value}\n`,
    encoding: 'utf8',
  });
  // A fast-exiting login closes stdin early and surfaces EPIPE beside a real
  // `status`; `status == null` is the signal that the process never ran.
  if (result.error && result.status == null) {
    warn(`${agent.command} login did not run: ${result.error.code === 'ENOENT' ? 'not found on PATH' : result.error.message}.`);
  } else if (result.status !== 0) {
    warn(`${agent.command} could not accept the ${credential.name} credential (exit ${result.status}).`);
  }
}

/**
 * Refuse a TEA version whose CLI cannot do what this action asks. An older CLI
 * fails on the first unknown option with an error that reads like a flag typo;
 * its `--help` names the options it really has. A package with no
 * tea-test-review bin lands here as "could not start".
 */
function assertCliIsCurrent(teaVersion, { publishAs = false } = {}, runner = spawnSync) {
  const help = runner(binaryName('tea-test-review'), ['--help'], { encoding: 'utf8' });
  const spec = teaInstallSource(teaVersion);
  if (help.error) {
    throw new Error(
      `tea-test-review could not start after installing ${spec} (${help.error.message}). ` +
        'Set tea-version to a release that ships the tea-test-review CLI.'
    );
  }
  const missing = ['--github', ...(publishAs ? ['--publish-as'] : [])].filter((flag) => !String(help.stdout).includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `${spec} predates ${missing.join(' and ')}, which this action drives, so its CLI cannot post the comment or the check run under the right identity. ` +
        `Set tea-version to a release whose \`tea-test-review --help\` lists ${missing.join(' and ')}.`
    );
  }
}

/** React to the triggering comment so a mention is acknowledged for the minutes a review takes. Never throws: it is cosmetic. */
async function addReaction({ owner, repo, token, apiUrl }, commentId, content = 'eyes') {
  const endpoint = `${String(apiUrl || 'https://api.github.com').replace(/\/+$/, '')}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
        'user-agent': 'muratkeremozcan/tea-test-review',
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  } catch (err) {
    warn(`Could not react to the triggering comment: ${err.message}. The review still runs; this is cosmetic.`);
  }
}

function readJsonIfPresent(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the review CLI and read back its verdict. Report and verdict from an
 * earlier invocation in the job are removed first: the CLI can exit before
 * writing either, and a stale file would be read as this run's verdict.
 */
function runReviewCli(opts, args, commandRunner = runCommand) {
  for (const artifact of [opts.reportPath, opts.jsonPath]) {
    fs.rmSync(path.resolve(opts.workspace, artifact), { force: true });
  }
  const status = commandRunner(binaryName('tea-test-review'), args, {
    cwd: opts.workspace,
    env: childEnv(opts.credential, process.env, os.userInfo(), { token: opts.token, apiUrl: opts.apiUrl }),
  });
  return { status, verdict: readJsonIfPresent(path.resolve(opts.workspace, opts.jsonPath)) };
}

// ─── trigger resolution ───────────────────────────────────────────────────────

/**
 * Comment authors trusted to spend the repository's secrets on a review. An
 * issue_comment run executes with the base repository's secrets and checks out
 * the PR's code, so this list is the security model. CONTRIBUTORS and below are
 * deliberately absent.
 */
const MENTION_TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function parseMode(raw) {
  const mode = String(raw == null ? '' : raw).trim().toLowerCase() || 'auto';
  if (mode !== 'auto' && mode !== 'manual') throw new Error(`mode must be auto or manual, got "${raw}"`);
  return mode;
}

/** Space-separated trigger list. Any token matches; @-mentions are convention, not law. */
function parseMentions(raw) {
  return String(raw == null ? '' : raw).split(/\s+/).filter(Boolean);
}

/** Longest focus note: it travels verbatim in the prompt, so a huge comment must not dominate it. */
const MAX_FOCUS_LENGTH = 1000;

/**
 * Index of the first boundary-valid occurrence of the mention, or -1. Word-
 * delimited on both sides and case-sensitive: '@claude' fires on '@claude,' but
 * not '@claude-alt', 'team@claude' or '@Claude'. A failed occurrence does not
 * hide a later valid one.
 */
function mentionIndex(body, mention) {
  const boundary = (ch) => ch === undefined || !/[A-Za-z0-9_-]/.test(ch);
  let index = body.indexOf(mention);
  while (index !== -1) {
    if (boundary(body[index - 1]) && boundary(body[index + mention.length])) return index;
    index = body.indexOf(mention, index + 1);
  }
  return -1;
}

/** First matching mention in CONFIGURATION order, not comment order: the prompt list is the priority. */
function matchMention(commentBody, mentions) {
  const body = String(commentBody || '');
  return mentions.find((mention) => mentionIndex(body, mention) !== -1) || null;
}

/** Whatever follows the accepted mention is the focus note, capped at MAX_FOCUS_LENGTH. */
function extractFocus(commentBody, mention) {
  const body = String(commentBody || '');
  const index = mentionIndex(body, mention);
  return index === -1 ? '' : body.slice(index + mention.length).trim().slice(0, MAX_FOCUS_LENGTH);
}

/** A mention that names a built-in vendor selects that agent; anything else keeps the agent input. */
function agentForMention(mention, agents = AGENTS) {
  const key = String(mention || '').replace(/^@/, '');
  return Object.hasOwn(agents, key) ? key : null;
}

/**
 * Whether this event triggers a review, and on whose terms. auto runs on
 * pull_request, any non-comment event, and a mention comment; manual only on a
 * mention comment. A mention naming a built-in vendor selects that agent and
 * resets model and agent-args to its pinned defaults, since the configured ones
 * would not parse. The authorization bar lives here, not in caller YAML, because
 * a copied `if:` drifts and this decides who may spend the base repo's secrets.
 */
function resolveTrigger({ mode, mentions, agentInput, payload, eventName }) {
  if (mode === 'manual' && mentions.length === 0) throw new Error('mode is manual but prompt is empty: nothing would ever trigger the review.');

  const skip = (reason) => ({ proceed: false, reason });

  if (eventName === 'pull_request') {
    return mode === 'auto'
      ? { proceed: true, via: 'pull_request', agent: agentInput, agentSwitched: false, focus: '' }
      : skip('mode is manual: pull_request events do not trigger the review (comment a mention on the PR instead)');
  }

  // Runs on the base branch, where the checkout holds no pull request code: the diff would be empty and the review a neutral skip.
  if (eventName === 'pull_request_target') {
    return skip('pull_request_target runs on the base branch, so there is no pull request code to review (use pull_request, or comment a mention)');
  }

  if (eventName !== 'issue_comment') {
    return mode === 'auto'
      ? { proceed: true, via: eventName || 'event', agent: agentInput, agentSwitched: false, focus: '' }
      : skip(`mode is manual: ${eventName || 'this'} events do not trigger the review`);
  }

  if (mentions.length === 0) return skip('no prompt mentions are configured');
  if (!payload?.issue?.pull_request) return skip('the comment is not on a pull request');
  if (payload?.comment?.user?.type === 'Bot') return skip('bot comments do not trigger the review');
  const body = payload?.comment?.body || '';
  const mention = matchMention(body, mentions);
  if (!mention) return skip(`the comment contains none of the configured mentions (${mentions.join(', ')})`);
  const association = payload?.comment?.author_association || '';
  if (!MENTION_TRUSTED_ASSOCIATIONS.includes(association)) {
    return skip(`comment author association "${association || 'NONE'}" is not one of ${MENTION_TRUSTED_ASSOCIATIONS.join(', ')}`);
  }
  const mentionAgent = agentForMention(mention);
  const agent = mentionAgent || agentInput;
  return {
    proceed: true,
    via: 'mention',
    agent,
    agentSwitched: Boolean(mentionAgent && mentionAgent !== agentInput),
    focus: extractFocus(body, mention),
    mention,
  };
}

// ─── orchestration ────────────────────────────────────────────────────────────

function buildOptions(env = process.env, { agentOverride = '', agentSwitched = false, focus = '' } = {}) {
  const agent = resolveAgent({
    agent: agentOverride || getInput('agent', env),
    // Like model and agent-args, these describe the configured agent: after a mention switch they would install and run the wrong vendor.
    agentPackage: agentSwitched ? '' : getInput('agent-package', env),
    agentCommand: agentSwitched ? '' : getInput('agent-command', env),
    agentKeyEnv: agentSwitched ? '' : getInput('agent-key-env', env),
    agentVersions: {
      claude: getInput('claude-code-version', env) || 'latest',
      codex: getInput('codex-version', env) || 'latest',
    },
  });

  const credential = resolveCredential(
    {
      anthropicApiKey: getInput('anthropic-api-key', env),
      claudeCodeOauthToken: getInput('claude-code-oauth-token', env),
      openaiApiKey: getInput('openai-api-key', env),
      agentApiKey: getInput('agent-api-key', env),
    },
    agent,
    env
  );

  return {
    agent,
    credential,
    teaVersion: getInput('tea-version', env) || DEFAULT_TEA_SOURCE,
    baseRef: resolveBaseRef(getInput('base-ref', env), env),
    reportPath: getInput('report-path', env) || 'test-review.md',
    jsonPath: getInput('json-path', env) || 'test-review.json',
    cli: {
      // Per-vendor knobs reset when a mention switched vendors: they would not parse on the new one.
      model: agentSwitched ? '' : getInput('model', env),
      agentArgs: agentSwitched ? [] : parseExtraArgs(getInput('agent-args', env), 'agent-args'),
      focus,
      testDir: getInput('test-dir', env),
      scope: getInput('scope', env),
      minScore: getInput('min-score', env),
      maxCritical: getInput('max-critical', env),
      minFiles: getInput('min-files', env),
      failOn: getInput('fail-on', env),
      gateOn: getInput('gate-on', env),
      usePlaywrightUtils: parseTriState(getInput('use-playwright-utils', env), 'use-playwright-utils'),
      usePactjsUtils: parseTriState(getInput('use-pactjs-utils', env), 'use-pactjs-utils'),
      pactMcp: parsePactMcp(getInput('pact-mcp', env)),
      extraArgs: parseExtraArgs(getInput('extra-args', env)),
    },
    comment: getBooleanInput('comment', env),
    checkRun: getBooleanInput('check-run', env),
    checkRunName: getInput('check-run-name', env) || 'TEA Test Review',
    // The upload step in action.yml tests `== 'true'`; 'yes' or '1' would name an artifact that is never uploaded.
    uploadReport: getInput('upload-report', env).toLowerCase() === 'true',
    token: getInput('github-token', env),
    apiUrl: getInput('github-api-url', env) || 'https://api.github.com',
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
  };
}

/** The complete CLI argv for this run: inputs, trigger and event in, flags out. */
function planCliArgs(opts, prNumber, env = process.env) {
  const plan = planGithub({ ...opts, extraArgs: opts.cli.extraArgs }, prNumber);
  return {
    plan,
    args: buildCliArgs({
      ...opts.cli,
      ...plan,
      baseRef: opts.baseRef,
      reportPath: opts.reportPath,
      jsonPath: opts.jsonPath,
      cliAgent: opts.agent.cliAgent,
      agentCommand: opts.agent.command,
      envPass: opts.agent.needsEnvPass ? opts.agent.credentialEnvNames[0] : '',
      // A custom vendor runs as --agent claude; its own tag keeps its comment from sharing claude's.
      publishAs: opts.agent.verified ? '' : opts.agent.tag,
      comment: opts.comment,
      checkRun: opts.checkRun,
      checkRunName: opts.checkRunName,
      // Must match the upload step's name in action.yml; a test pins the two.
      artifactName: opts.uploadReport && env.GITHUB_JOB ? `tea-test-review-${env.GITHUB_JOB}-${opts.agent.tag}` : null,
    }),
  };
}

async function run(env = process.env) {
  const payload = env.GITHUB_EVENT_PATH ? readJsonIfPresent(env.GITHUB_EVENT_PATH) : null;
  const trigger = resolveTrigger({
    mode: parseMode(getInput('mode', env)),
    mentions: parseMentions(getInput('prompt', env)),
    agentInput: getInput('agent', env) || 'claude',
    payload,
    eventName: env.GITHUB_EVENT_NAME,
  });
  if (!trigger.proceed) {
    notice(`TEA Test Review not triggered: ${trigger.reason}.`);
    setOutput('skipped', 'true');
    return 0;
  }

  const opts = buildOptions(env, {
    agentOverride: trigger.agent,
    agentSwitched: trigger.agentSwitched,
    focus: trigger.focus,
  });
  const repo = parseRepository(env);

  // React before the installs, so the mention is acknowledged at once.
  if (trigger.via === 'mention' && opts.comment && repo && opts.token && payload?.comment?.id != null) {
    await addReaction({ ...repo, token: opts.token, apiUrl: opts.apiUrl }, payload.comment.id, 'eyes');
  }

  // Set before anything can fail: the upload step names the artifact from it, including after a mention switch.
  setOutput('agent', opts.agent.key);
  setOutput('agent-tag', opts.agent.tag);

  const { plan, args } = planCliArgs(opts, resolvePrNumber(payload, env), env);
  log(`TEA Test Review: ${teaInstallSource(opts.teaVersion)}, agent ${opts.agent.key} (${opts.agent.packageSpec})`);
  log(`  base ref: ${opts.baseRef || '(resolved by the CLI)'}, credential: ${opts.credential?.name ?? '(none)'}`);
  if (trigger.via === 'mention') {
    log(`  triggered by a "${trigger.mention}" comment${trigger.focus ? `, focus: ${trigger.focus}` : ''}`);
  }
  if (trigger.agentSwitched) {
    log(`  the mention selected ${trigger.agent}: model and agent-args reset to that vendor's pinned defaults`);
  }
  if (plan.dryRun && (opts.comment || opts.checkRun)) {
    notice('extra-args select --agent none, a dry run that reviews nothing, so no comment or check run is published.');
  }
  if (!opts.agent.verified) {
    warn(
      `Agent "${opts.agent.key}" is not a built-in vendor. It runs as --agent claude --agent-cmd ${opts.agent.command}: the CLI ` +
        "spawns it with claude's argv and the prompt on stdin, and it fails as an agent error unless it accepts that grammar. " +
        'Prove it with a live run before requiring this as a gate.'
    );
  }

  // The CLI carries its own review skill: one install, one version, out of the pull request's reach.
  installCli(opts.teaVersion, opts.agent.packageSpec);
  assertCliIsCurrent(opts.teaVersion, { publishAs: !opts.agent.verified });
  agentLogin(opts.agent, opts.credential);

  const { status, verdict } = runReviewCli(opts, args);
  for (const [name, value] of Object.entries(outputsFromVerdict(verdict))) setOutput(name, value);
  setOutput('report-path', opts.reportPath);
  setOutput('json-path', opts.jsonPath);

  const meaning = EXIT_MEANING[status] || `unexpected exit code ${status}`;
  if (status === 0) {
    if (verdict?.skipped) notice(`Review skipped: ${verdict.reason ?? 'no changed test files'}.`);
    else if (verdict?.waived) notice(`Verdict failure waived: ${verdict.waiveReason ?? 'no reason recorded'}.`);
    else if (verdict?.promptOnly) notice('Dry run: the CLI built the prompt and reviewed nothing.');
    else log(`Review passed: ${verdict?.recommendation ?? 'no verdict recorded'}.`);
    return 0;
  }

  // Exit 2 and 3 are not verdicts: tests that need work and a gate that did not run read differently.
  if (status === 1) log(`::error::TEA Test Review failed: ${meaning}. See the report at ${opts.reportPath}.`);
  else log(`::error::TEA Test Review did not produce a verdict: ${meaning}. Treat this as a broken gate, not as approved tests.`);
  return status;
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log(`::error::${err && err.message ? err.message : String(err)}`);
      process.exitCode = 2;
    });
}

module.exports = {
  AGENTS, CLI_RETRIES, DEFAULT_TEA_SOURCE, teaInstallSource, installCli, MENTION_TRUSTED_ASSOCIATIONS, MAX_FOCUS_LENGTH,
  getInput, getBooleanInput, setOutput, binaryName, resolveBaseRef,
  parseMode, parseMentions, matchMention, extractFocus, agentForMention, resolveTrigger,
  parseTriState, parsePactMcp, parseExtraArgs, resolveAgent, resolveCredential, agentLogin,
  childEnv, planGithub, buildCliArgs, planCliArgs, assertCliIsCurrent, outputsFromVerdict,
  resolvePrNumber, parseRepository, addReaction, buildOptions, runReviewCli, run,
};
