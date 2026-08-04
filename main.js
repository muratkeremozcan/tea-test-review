'use strict';

/**
 * TEA Test Review: run the headless test-quality review on a pull request's
 * changed test files, gate the step on its verdict, and publish the full report
 * as one upserted PR comment.
 *
 * The load-bearing distinction in here is between a verdict and a broken gate.
 * The review CLI already separates them by exit code (1 is a verdict failure, 2
 * and 3 are an unusable gate), and this action never collapses them: a failure to
 * post a comment is a warning, an unreadable verdict is reported as broken rather
 * than as approved tests, and no path turns a non-zero CLI exit into a pass.
 *
 * Zero dependencies on purpose: no node_modules to audit, no bundle step, and no
 * third-party JavaScript between a pull request and the check that blocks it.
 * `npm` and `tar` are system binaries, and the GitHub API is reached with the
 * runtime's global fetch rather than octokit.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── workflow command helpers (replaces @actions/core, which would need deps) ──

/**
 * Mirrors @actions/core's lookup rule: uppercase the name, spaces to
 * underscores, dashes preserved. So `github-token` reads INPUT_GITHUB-TOKEN.
 */
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
    // Delimiter form, matching @actions/core. The `name=value` form lets a
    // newline in a value inject further output parameters, and one of these
    // values is a recommendation string lifted out of an agent-written report.
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

/** Where the skill lives inside the packed tarball, once `tar -xzf` has run. */
const SKILL_SUBPATH = path.join('package', 'src', 'workflows', 'testarch', 'bmad-testarch-test-review');

const COMMENT_MARKER = '<!-- tea-test-review -->';

/**
 * GitHub caps a comment body at 65536 characters. This leaves headroom for the
 * digest and the <details> wrapper around the inlined report.
 */
const MAX_INLINE_REPORT_CHARS = 40000;

/**
 * Cap on the file paths listed in the comment digest. Past this the list stops
 * being a digest; the full manifest is in the report itself.
 */
const MAX_LISTED_REVIEWED_FILES = 10;

const REQUEST_TIMEOUT_MS = 30_000;
const COMMENT_RETRY_LIMIT = 3;

/** The CLI's exit codes, which this action passes through unchanged. */
const EXIT_MEANING = {
  0: 'review passed, was skipped, or a verdict failure was waived',
  1: 'review verdict failure',
  2: 'environment or configuration error, so the gate did not run',
  3: 'agent or report-parse failure, so there is no verdict',
};

/**
 * Vendors known to work: each has been proven by a live run against a real
 * test file, and a table row for an untested CLI is a claim this action
 * cannot make. `credentialInputs` is positional against `credentialEnvNames`
 * (same index = same slot), so resolveCredential can read the right input for
 * either variable without a per-vendor branch.
 *
 * An unknown `agent` value is not an error: it resolves through agent-package,
 * agent-command and agent-key-env, so adding a vendor the CLI does not know
 * natively is data the caller passes rather than an edit here. It runs by
 * impersonating claude's protocol through --agent-cmd (see resolveAgent's
 * `cliAgent: 'claude'` fallback), which is what today's tea-test-review CLI
 * (bmad-method-test-architecture-enterprise) actually spawns: `-p
 * --output-format text --tools Read,Write,Edit,Glob,Grep --allowedTools ...
 * --safe-mode` on the claude adapter, prompt on stdin. When the custom
 * executable does not speak that grammar the failure surfaces inside the CLI
 * as exit 3, which is honest but is not support.
 *
 * Adding a vendor the CLI *does* know natively (i.e. a new key in its own
 * cli/lib/agent-adapters.js) is still an edit here: a new AGENTS entry plus
 * the version input that pins it in action.yml/buildOptions.
 */
const AGENTS = {
  claude: {
    package: '@anthropic-ai/claude-code',
    command: 'claude',
    // Either credential works. ANTHROPIC_API_KEY bills per token through the
    // Anthropic Console; CLAUDE_CODE_OAUTH_TOKEN is a long-lived token minted
    // from an existing subscription with `claude setup-token`.
    credentialEnvNames: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    credentialInputs: ['anthropicApiKey', 'claudeCodeOauthToken'],
    // Already in the CLI's run-agent.js BASE_ENV_NAMES, so no --env-pass needed.
    needsEnvPass: false,
  },
  codex: {
    package: '@openai/codex',
    command: 'codex',
    credentialEnvNames: ['OPENAI_API_KEY'],
    credentialInputs: ['openaiApiKey'],
    // Already in the CLI's codex adapter envNames (cli/lib/agent-adapters.js),
    // so no --env-pass needed, same reasoning as claude.
    needsEnvPass: false,
    // codex 0.146.0 does not read OPENAI_API_KEY from the environment; it
    // authenticates only from ~/.codex/auth.json, which no runner has. Passing
    // the variable alone sends no credential at all and the run dies on
    // "Missing bearer or basic authentication in header". This writes the file
    // first. The key travels on stdin, never argv, so it stays out of the log.
    loginArgv: ['login', '--with-api-key'],
  },
};

// ─── pure logic, exported for tests ───────────────────────────────────────────

/** npm-installed executables are `.cmd` shims on Windows, and spawn without a shell will not find them. */
function binaryName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.cmd` : name;
}

/**
 * Base ref for the changed-test diff. Derived from the event rather than
 * defaulted to origin/main, because a pull request into a release branch would
 * otherwise diff against the wrong base and review files it never touched.
 */
function resolveBaseRef(raw, env = process.env) {
  const explicit = String(raw == null ? '' : raw).trim();
  if (explicit !== '') return explicit;
  const base = String(env.GITHUB_BASE_REF || '').trim();
  return base ? `origin/${base}` : 'origin/main';
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

/**
 * Split an action argument-list input the way a shell would, honouring single
 * and double quotes so one argument can contain spaces. Deliberately not a
 * shell: the tokens go straight into an argv array, so no interpolation,
 * globbing or command substitution is possible from an input.
 */
function parseExtraArgs(raw, inputName = 'extra-args') {
  const s = String(raw == null ? '' : raw);
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of s) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw new Error(`${inputName} has an unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Resolve the agent vendor into an install spec, an executable, a credential
 * environment variable name, and the `--agent` value the CLI itself
 * understands (`cliAgent`).
 *
 * `cliAgent` and `key` diverge exactly once: an unknown vendor is not one of
 * the CLI's own adapters, so it cannot be named on `--agent` at all (the CLI
 * rejects anything outside its own table) and instead runs as claude's
 * protocol via `--agent-cmd`, unchanged from how this action has always run
 * a custom vendor.
 */
function resolveAgent({ agent, agentPackage, agentCommand, agentKeyEnv, agentVersions = {} }) {
  const key = String(agent == null ? '' : agent).trim() || 'claude';
  const known = AGENTS[key];

  if (known) {
    const pinnedVersion = agentVersions[key];
    const packageSpec = agentPackage || (pinnedVersion ? `${known.package}@${pinnedVersion}` : known.package);
    return {
      key,
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
    // Impersonates claude's protocol through --agent-cmd: see the AGENTS
    // doc comment above for why that is the only option outside the CLI's
    // own adapter table.
    cliAgent: 'claude',
    verified: false,
    packageSpec: agentPackage,
    command: agentCommand || key,
    credentialEnvNames: [agentKeyEnv],
    // Only the built-in vendors' variables are in the CLI's BASE_ENV_NAMES /
    // adapter envNames, so any other credential has to be allowlisted
    // explicitly with --env-pass.
    needsEnvPass: true,
  };
}

/**
 * Pick the credential to inject, preferring an explicit input over one the
 * caller put in the step's own `env:`.
 *
 * A missing credential throws rather than skipping. A required check that
 * quietly passes when it could not run gives no protection at all, which is the
 * same reason the fork case is documented as a caller-side `if:` guard instead
 * of being swallowed here.
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

  throw new Error(
    `no credential for the ${agent.key} agent: set one of ${agent.credentialEnvNames.join(' or ')}, ` +
      'as an input or in the step\'s env. Fork pull requests receive no secrets, so guard this job with ' +
      "`if: github.event.pull_request.head.repo.full_name == github.repository` on the caller's side."
  );
}

/**
 * The environment the review CLI runs in.
 *
 * HOME, USER and LOGNAME are load-bearing rather than cosmetic. The CLI narrows
 * the environment again before spawning the agent, and without USER neither
 * claude nor codex can read their stored credentials — both report a
 * not-logged-in error, turning every run into an agent failure.
 */
function childEnv(credential, env = process.env, userInfo = os.userInfo()) {
  const out = { ...env };
  if (credential) out[credential.name] = credential.value;
  if (!out.HOME) out.HOME = userInfo.homedir;
  if (!out.USER) out.USER = userInfo.username;
  if (!out.LOGNAME) out.LOGNAME = out.USER;
  return out;
}

/**
 * Build the tea-test-review argv.
 *
 * --agent is opts.cliAgent, the value resolveAgent decided the CLI's own
 * adapter table actually understands (claude or codex today; claude for any
 * vendor outside that table). --agent-cmd layers an executable override on
 * top of it only when the resolved command differs from cliAgent itself —
 * which is exactly when agent-command was set, or when the vendor is a
 * custom one impersonating claude's protocol under its own binary name.
 *
 * `model` is only forwarded when set. Left empty the review CLI applies its own
 * per-vendor pinned default, which is still deterministic; the input exists to
 * choose a different model, not to decide whether one is pinned at all.
 */
function buildCliArgs(opts) {
  const args = [
    '--base',
    opts.baseRef,
    '--agent',
    opts.cliAgent,
    '--skill-root',
    opts.skillRoot,
    '--output',
    opts.reportPath,
    '--json',
    opts.jsonPath,
  ];

  if (opts.agentCommand !== opts.cliAgent) args.push('--agent-cmd', opts.agentCommand);
  if (opts.envPass) args.push('--env-pass', opts.envPass);
  if (opts.model) args.push('--model', opts.model);
  for (const arg of opts.agentArgs || []) args.push(`--agent-arg=${arg}`);
  if (opts.testDir) args.push('--test-dir', opts.testDir);
  if (opts.scope) args.push('--scope', opts.scope);
  if (opts.focus) args.push('--focus', opts.focus);
  if (opts.minScore) args.push('--min-score', opts.minScore);
  if (opts.maxCritical) args.push('--max-critical', opts.maxCritical);
  if (opts.minFiles) args.push('--min-files', opts.minFiles);
  if (opts.failOn) args.push('--fail-on', opts.failOn);

  if (opts.usePlaywrightUtils === true) args.push('--use-playwright-utils');
  if (opts.usePlaywrightUtils === false) args.push('--no-use-playwright-utils');
  if (opts.usePactjsUtils === true) args.push('--use-pactjs-utils');
  if (opts.usePactjsUtils === false) args.push('--no-use-pactjs-utils');
  if (opts.pactMcp) args.push('--pact-mcp', opts.pactMcp);

  return [...args, ...(opts.extraArgs || [])];
}

/**
 * Name of the tarball `npm pack` just wrote. Read from --json output, falling
 * back to whatever .tgz appeared in the directory, because predicting the
 * filename only works when the version is an exact number and `tea-version`
 * accepts a dist-tag.
 */
function packedTarballName(stdout, dirEntries = []) {
  try {
    const parsed = JSON.parse(String(stdout || ''));
    const name = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
    if (name) return name;
  } catch {
    /* fall through to the directory scan */
  }
  const tarballs = dirEntries.filter((entry) => entry.endsWith('.tgz'));
  if (tarballs.length === 1) return tarballs[0];
  if (tarballs.length === 0) throw new Error('npm pack wrote no tarball');
  throw new Error(`npm pack left ${tarballs.length} tarballs behind, cannot tell which is the pinned one`);
}

/**
 * Refuse a TEA version that does not ship the CLI this action drives.
 *
 * Checked against the unpacked tarball's own package.json, before the global
 * install, because the alternative failure is `tea-test-review not found on
 * PATH` after two installs, which reads like a runner problem rather than a
 * version that never had the binary.
 *
 * Not hypothetical: every release before 1.20.0 publishes the review skill with
 * an empty `bin`, and npm versions are immutable, so those will never gain it.
 * Reachable through `latest` only by a downgrade, and through an explicit pin.
 */
function assertShipsCli(packageJson, spec) {
  const bin = packageJson?.bin;
  const hasBin = typeof bin === 'string' || (bin && typeof bin === 'object' && bin['tea-test-review']);
  if (hasBin) return;
  throw new Error(
    `${spec} does not ship the tea-test-review CLI (its package.json declares no such bin), so there is ` +
      'nothing for this action to run. The package publishes the review skill; the headless CLI is newer than ' +
      'that release. Set tea-version to the first version that ships it.'
  );
}

/** Verdict fields to step outputs. A skipped review has nulls, not zeros. */
function outputsFromVerdict(verdict) {
  const v = verdict || {};
  const counts = v.violations || {};
  const skipped = v.skipped === true;
  return {
    recommendation: skipped || v.recommendation == null ? '' : String(v.recommendation),
    'quality-score': skipped || v.qualityScore == null ? '' : String(v.qualityScore),
    critical: String(counts.critical ?? 0),
    high: String(counts.high ?? 0),
    medium: String(counts.medium ?? 0),
    low: String(counts.low ?? 0),
    'reviewed-files': String((v.reviewedFiles || []).length),
    skipped: skipped ? 'true' : 'false',
  };
}

/** Only well-formed path strings; a malformed verdict must not break the comment. */
function asPathList(files) {
  return (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f.length > 0);
}

/** Up to MAX_LISTED_REVIEWED_FILES paths as bullets, then one overflow line. */
function cappedPathBullets(files, indent = '') {
  const bullets = files.slice(0, MAX_LISTED_REVIEWED_FILES).map((f) => `${indent}- \`${f}\``);
  if (files.length > MAX_LISTED_REVIEWED_FILES) bullets.push(`${indent}- … and ${files.length - MAX_LISTED_REVIEWED_FILES} more`);
  return bullets;
}

/**
 * Fence the report's leading YAML frontmatter so it renders as small monospace
 * text instead of a heading.
 *
 * The report opens with `---\nkey: value\n---`. Markdown reads the closing `---`
 * as a setext underline for the lines above it, so the whole resume-state block
 * renders as an <h2>: the largest, boldest text in the comment is workflow
 * bookkeeping, sitting directly above the actual report title. Fencing it keeps
 * the block verbatim for the paste-into-your-agent path while dropping it to
 * code-block size.
 *
 * Only a frontmatter block at the very start is touched, and only when it
 * closes; a report whose body contains `---` thematic breaks is left alone.
 */
function fenceLeadingFrontmatter(reportText) {
  const text = String(reportText ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return text;
  // A frontmatter value containing a fence would end ours early and spill the
  // rest of the report out of the block, so back off rather than corrupt it.
  if (match[1].includes('```')) return text;
  return `\`\`\`yaml\n${match[1]}\n\`\`\`${match[2]}${text.slice(match[0].length)}`;
}

/**
 * Comment body, ported from cli/examples/pr-test-review.yml's github-script step
 * so both surfaces read identically.
 *
 * The full report is inlined in a collapsed <details> block rather than only
 * linked, so a reviewer can paste it straight into their own coding agent and
 * apply the fixes without downloading anything. That is the feature the comment
 * exists for, and the digest above it is the part you read to decide whether to
 * bother.
 */
function buildCommentBody({ verdict, reportText, runUrl, reportPath, reviewResult, artifactName, focus }) {
  if (!verdict) {
    return [
      COMMENT_MARKER,
      '## TEA Test Review: infrastructure failure',
      '',
      'The review produced no readable verdict.',
      'This is **not** a review verdict; treat the gate as broken, not as approved tests.',
      '',
      `Review result: ${reviewResult || 'unknown'}.`,
      `[Workflow run](${runUrl})`,
    ].join('\n');
  }

  // `--agent none` through extra-args: the CLI built the prompt and ran nothing.
  // Without this branch the digest below renders a recommendation of "undefined"
  // and reads like a verdict.
  if (verdict.promptOnly) {
    const files = asPathList(verdict.files);
    return [
      COMMENT_MARKER,
      '## TEA Test Review: no review performed',
      '',
      'The CLI ran with `--agent none`, so it built the prompt and stopped. This is a dry run, not a verdict.',
      '',
      `Files that would have been reviewed: ${files.length}.`,
      ...cappedPathBullets(files),
      '',
      `[Workflow run](${runUrl})`,
    ].join('\n');
  }

  if (verdict.skipped) {
    // The context set travels in the skipped payload, so the comment can say
    // what the PR DID change. And when the run came from a mention with focus
    // text, the skip must acknowledge it: silently dropping the requester's
    // words reads as if the mention was never heard.
    const contextCount = Array.isArray(verdict.contextFiles) ? verdict.contextFiles.length : 0;
    const changed = contextCount > 0 ? ` (${contextCount} other file${contextCount === 1 ? '' : 's'} changed)` : '';
    const lines = [COMMENT_MARKER, '## TEA Test Review: skipped', '', `${verdict.reason ?? 'No changed test files in this PR'}${changed}.`];
    if (focus) {
      lines.push(
        '',
        'You asked me to focus on:',
        '',
        ...String(focus)
          .split('\n')
          .map((line) => `> ${line}`),
        '',
        'There were no tests in scope to apply that to.'
      );
    }
    lines.push('', `[Workflow run](${runUrl})`);
    return lines.join('\n');
  }

  const counts = verdict.violations ?? {};
  const violations = `${counts.critical ?? 0} Critical / ${counts.high ?? 0} High / ${counts.medium ?? 0} Medium / ${counts.low ?? 0} Low`;
  const weaknesses = (verdict.keyWeaknesses ?? []).slice(0, 3);
  // Named, not just counted: a finding that cites "line 200" is unattributable
  // on a pull request touching more than one test file.
  const reviewed = asPathList(verdict.reviewedFiles);

  const lines = [
    COMMENT_MARKER,
    `## TEA Test Review: ${verdict.recommendation}`,
    '',
    `- **Quality score**: ${verdict.qualityScore ?? 'n/a'}/100`,
    `- **Recommendation**: ${verdict.recommendation}`,
    `- **Violations**: ${violations}`,
    `- **Reviewed files**: ${reviewed.length}`,
    ...cappedPathBullets(reviewed, '  '),
  ];

  // A score with no attribution cannot be compared to another score. The CLI
  // already puts the resolved agent and model in the verdict JSON for exactly
  // that reason; without this line the human surface loses it, and 82 from one
  // vendor reads as interchangeable with 82 from another.
  const reviewer = [verdict.agent, verdict.model].filter((v) => typeof v === 'string' && v.length > 0);
  if (reviewer.length > 0) {
    lines.push(`- **Reviewer**: ${reviewer.join(' / ')}`);
  }

  if (verdict.waived) {
    lines.push(
      `- **Waived**: ${verdict.waiveReason ?? 'no reason recorded'} (until ${verdict.waiveUntil ?? 'unspecified'})`
    );
  }
  if (Array.isArray(verdict.gateFailures) && verdict.gateFailures.length > 0) {
    lines.push(`- **Gate failures**: ${verdict.gateFailures.join('; ')}`);
  }
  if (weaknesses.length > 0) {
    lines.push('', '**Key weaknesses**:', ...weaknesses.map((w) => `- ${w}`));
  }
  lines.push('');

  if (reportText && reportText.length <= MAX_INLINE_REPORT_CHARS) {
    // A reviewed file's own content can contain a literal </details>; inserting
    // a zero-width space breaks that as an HTML closing tag while leaving the
    // visible text effectively unchanged, so it cannot end this block early and
    // spill raw markdown into the rest of the comment.
    const safeReportText = fenceLeadingFrontmatter(reportText).replace(/<\/details>/gi, '<\u200B/details>');
    lines.push(
      '<details>',
      '<summary>Full report (paste into your AI coding agent to apply the fixes)</summary>',
      '',
      safeReportText,
      '',
      '</details>',
      '',
      `[Workflow run](${runUrl})`
    );
  } else {
    const why = reportText
      ? `too large to inline (${reportText.length} characters, limit ${MAX_INLINE_REPORT_CHARS})`
      : 'not readable from the workspace';
    // The artifact only helps when the report existed to be uploaded; an
    // unreadable report is missing from both places.
    const recovery =
      reportText && artifactName
        ? `It is uploaded as the \`${artifactName}\` artifact on the workflow run.`
        : `It is in the workspace at \`${reportPath}\`, which the runner deletes when the job ends` +
          (artifactName ? '.' : '; enable `upload-report` or add an `actions/upload-artifact` step to keep it.');
    lines.push(`The full report is ${why}. ${recovery}`, '', `[Workflow run](${runUrl})`);
  }

  return lines.join('\n');
}

/** The comment this action owns, found by its hidden marker. */
function findOwnComment(comments) {
  return (comments || []).find((comment) => comment && comment.body && comment.body.includes(COMMENT_MARKER)) || null;
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

function workflowRunUrl(env = process.env) {
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/** Retry a transient failure only. A 403 on a missing permission will not fix itself. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// ─── IO ───────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a command with its output streamed straight through.
 *
 * stdio: 'inherit' is what makes the review readable while it runs. The CLI
 * prints a heartbeat every 15 seconds from a detached process, because its own
 * agent call blocks synchronously and a real review takes minutes; capturing
 * stdout here would swallow it and the job would look hung.
 */
function runCommand(command, args, options = {}) {
  log(`+ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(`${command} not found on PATH`);
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function runCommandChecked(command, args, options = {}) {
  const status = runCommand(command, args, options);
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${status}`);
}

/**
 * Write the agent's credential to its on-disk auth store, for vendors that
 * refuse to read it from the environment.
 *
 * Only codex needs this today (see the AGENTS table), and only when the
 * credential is an API key: a subscription login already wrote the file, and
 * runners have neither. Skipped silently for vendors without a loginArgv so
 * this stays data rather than a branch per agent.
 *
 * stdio is piped rather than inherited, so a vendor that echoes the key back
 * cannot land it in the workflow log, and the key goes through `input` rather
 * than argv, so it never appears in a process list either.
 */
function agentLogin(agent, credential) {
  if (!agent.loginArgv) return;
  log(`+ ${agent.command} ${agent.loginArgv.join(' ')} (credential on stdin)`);
  const result = spawnSync(binaryName(agent.command), agent.loginArgv, {
    input: `${credential.value}\n`,
    encoding: 'utf8',
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error(`${agent.command} not found on PATH`);
    throw new Error(`${agent.command} login failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${agent.command} could not accept the ${credential.name} credential (exit ${result.status}). ` +
        'The review never ran, so this is a broken gate rather than a verdict.'
    );
  }
}

/**
 * Unpack the review skill from a pinned tarball into a temp directory.
 *
 * Two things this must not do. It must not install the skill globally, because
 * npm has nowhere to put a workflow directory, and it must not land anywhere in
 * the checkout: a pull request that edits its own vendored `_bmad/` copy would
 * then be rewriting the reviewer that judges it. An explicit --skill-root
 * outside the workspace is untouchable by the diff.
 *
 * Returns the tarball path as well, because the CLI is then installed from this
 * same file rather than resolved from the registry a second time. With an exact
 * pin the two are identical anyway; with a dist-tag they are two resolutions of a
 * moving target, and the reviewer's skill and the code driving it would be free
 * to come from different versions.
 */
function installSkill(teaVersion, tmpRoot) {
  const npm = binaryName('npm');
  const spec = `${TEA_PACKAGE}@${teaVersion}`;

  log(`+ ${npm} pack ${spec}`);
  const packed = spawnSync(npm, ['pack', spec, '--json'], {
    cwd: tmpRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (packed.error) throw new Error(`npm pack failed: ${packed.error.message}`);
  if (packed.status !== 0) throw new Error(`npm pack ${spec} exited with code ${packed.status}`);

  const tarball = packedTarballName(packed.stdout, fs.readdirSync(tmpRoot));
  runCommandChecked(binaryName('tar'), ['-xzf', tarball], { cwd: tmpRoot });

  assertShipsCli(readJsonIfPresent(path.join(tmpRoot, 'package', 'package.json')), spec);

  const skillRoot = path.join(tmpRoot, SKILL_SUBPATH);
  if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) {
    throw new Error(
      `the pinned package ${spec} has no skill at ${SKILL_SUBPATH}. ` +
        'Check tea-version: the layout moved, or that version does not ship the review skill.'
    );
  }
  return { skillRoot, tarballPath: path.join(tmpRoot, tarball) };
}

async function githubRequest({ apiUrl, token, method, path: apiPath, body }) {
  const endpoint = `${String(apiUrl || 'https://api.github.com').replace(/\/+$/, '')}${apiPath}`;
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(endpoint, {
        method,
        headers: {
          authorization: `bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/vnd.github+json',
          'user-agent': 'muratkeremozcan/tea-test-review',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt > COMMENT_RETRY_LIMIT) throw new Error(`network error contacting the GitHub API: ${err.message}`);
      await sleep(1000 * attempt);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (isRetryableStatus(res.status) && attempt <= COMMENT_RETRY_LIMIT) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`GitHub API returned ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json().catch(() => null);
  }
}

/** Create the comment, or update the one this action already owns on the PR. */
async function upsertComment(ctx, prNumber, body) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubRequest({
      ...ctx,
      method: 'GET',
      path: `/repos/${ctx.owner}/${ctx.repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    comments.push(...batch);
    if (batch.length < 100) break;
  }

  const existing = findOwnComment(comments);
  if (existing) {
    await githubRequest({
      ...ctx,
      method: 'PATCH',
      path: `/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existing.id}`,
      body: { body },
    });
    return 'Updated';
  }
  await githubRequest({
    ...ctx,
    method: 'POST',
    path: `/repos/${ctx.owner}/${ctx.repo}/issues/${prNumber}/comments`,
    body: { body },
  });
  return 'Created';
}

function readJsonIfPresent(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfPresent(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function readEventPayload(env = process.env) {
  return env.GITHUB_EVENT_PATH ? readJsonIfPresent(env.GITHUB_EVENT_PATH) : null;
}

/**
 * Base ref when neither the caller nor the event stated one. A pull_request
 * run always sets GITHUB_BASE_REF; an issue_comment run on a pull request does
 * not, and the origin/main resolveBaseRef falls back to would then diff
 * against the wrong base and review files the PR never touched. The pulls API
 * is the only honest source left, and when it cannot answer the run fails
 * rather than reviewing the wrong set: pass base-ref explicitly to bypass the
 * lookup.
 */
async function resolveRunBaseRef({ baseRef, token, apiUrl }, payload, env = process.env) {
  const stated = getInput('base-ref', env) !== '' || String(env.GITHUB_BASE_REF || '').trim() !== '';
  if (stated) return baseRef;

  const prNumber = resolvePrNumber(payload, env);
  if (prNumber == null) return baseRef;

  const guidance = 'Pass base-ref explicitly to bypass the lookup.';
  const repo = parseRepository(env);
  if (!repo || !token) {
    throw new Error(
      `cannot resolve the base branch of #${prNumber}: GITHUB_BASE_REF is empty and there is no usable ` +
        'github-token. An issue_comment run carries no base ref, and guessing origin/main could review files ' +
        `the pull request never touched. ${guidance}`
    );
  }

  let pr;
  try {
    pr = await githubRequest({ apiUrl, token, method: 'GET', path: `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}` });
  } catch (err) {
    throw new Error(`cannot resolve the base branch of #${prNumber} from the GitHub API: ${err.message}. ${guidance}`);
  }
  const base = pr && pr.base && typeof pr.base.ref === 'string' ? pr.base.ref.trim() : '';
  if (base === '') {
    throw new Error(`the GitHub API returned no base ref for #${prNumber}. ${guidance}`);
  }
  log(`Base ref for #${prNumber} resolved through the API: origin/${base}`);
  return `origin/${base}`;
}

// ─── trigger resolution ───────────────────────────────────────────────────────

/**
 * Comment authors trusted to spend the repository's secrets on a review. An
 * issue_comment run executes with the base repository's secrets and checks
 * out the pull request's code, so this list is the whole security model on a
 * public repository. CONTRIBUTORS and below are deliberately absent.
 */
const MENTION_TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function parseMode(raw) {
  const mode = String(raw == null ? '' : raw).trim().toLowerCase() || 'auto';
  if (mode !== 'auto' && mode !== 'manual') {
    throw new Error(`mode must be auto or manual, got "${raw}"`);
  }
  return mode;
}

/** Space-separated trigger list. Any token matches; @-mentions are convention, not law. */
function parseMentions(raw) {
  return String(raw == null ? '' : raw)
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Longest focus note the review accepts. A PR comment can run to tens of
 * thousands of characters; the note travels verbatim in the prompt, so it is
 * capped here, before it can become the largest thing the agent reads.
 */
const MAX_FOCUS_LENGTH = 1000;

/**
 * Index of the first boundary-valid occurrence of the mention, or -1.
 * Word-delimited on BOTH sides and case-sensitive: '@claude' fires on
 * '@claude,' but not on '@claude-alt', 'team@claude', or '@Claude'. An
 * occurrence that fails the boundary check does not hide a later valid one.
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

/**
 * First matching mention in CONFIGURATION order (not the earliest occurrence
 * in the comment): the prompt list is the priority order.
 */
function matchMention(commentBody, mentions) {
  const body = String(commentBody || '');
  return mentions.find((mention) => mentionIndex(body, mention) !== -1) || null;
}

/**
 * Whatever the requester wrote after the mention is the review's focus note,
 * taken after the same boundary-valid occurrence the matcher accepted and
 * capped at MAX_FOCUS_LENGTH.
 */
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
 * Whether this event triggers a review, and on whose terms.
 *
 * auto runs on pull_request (and any non-comment event, the historical
 * behavior) and on a mention comment; manual runs only on a mention comment.
 * A mention that names a built-in vendor selects that vendor's agent for the
 * run, and the run then carries that vendor's pinned defaults rather than the
 * configured vendor's model and agent-args, which would not even parse.
 *
 * The authorization bar lives here rather than in caller YAML because a
 * copy-pasted `if:` is one more surface that drifts: an issue_comment run
 * executes with the base repository's secrets and checks out the PR's code,
 * so who may trigger it is not a per-repo decision.
 */
function resolveTrigger({ mode, mentions, agentInput, payload, eventName }) {
  if (mode === 'manual' && mentions.length === 0) {
    throw new Error('mode is manual but prompt is empty: nothing would ever trigger the review.');
  }

  const skip = (reason) => ({ proceed: false, reason });

  if (eventName === 'pull_request') {
    return mode === 'auto'
      ? { proceed: true, via: 'pull_request', agent: agentInput, agentSwitched: false, focus: '' }
      : skip('mode is manual: pull_request events do not trigger the review (comment a mention on the PR instead)');
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
    agentPackage: getInput('agent-package', env),
    agentCommand: getInput('agent-command', env),
    agentKeyEnv: getInput('agent-key-env', env),
    agentVersions: {
      claude: getInput('claude-code-version', env) || '2.1.220',
      codex: getInput('codex-version', env) || '0.146.0',
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
    teaVersion: getInput('tea-version', env) || 'latest',
    baseRef: resolveBaseRef(getInput('base-ref', env), env),
    reportPath: getInput('report-path', env) || 'test-review.md',
    jsonPath: getInput('json-path', env) || 'test-review.json',
    cli: {
      // A mention that switched vendors resets the per-vendor knobs: the
      // configured model and agent-args belong to the configured agent and
      // would not even parse on the one the mention selected.
      model: agentSwitched ? '' : getInput('model', env),
      agentArgs: agentSwitched ? [] : parseExtraArgs(getInput('agent-args', env), 'agent-args'),
      focus,
      testDir: getInput('test-dir', env),
      scope: getInput('scope', env),
      minScore: getInput('min-score', env),
      maxCritical: getInput('max-critical', env),
      minFiles: getInput('min-files', env),
      failOn: getInput('fail-on', env),
      usePlaywrightUtils: parseTriState(getInput('use-playwright-utils', env), 'use-playwright-utils'),
      usePactjsUtils: parseTriState(getInput('use-pactjs-utils', env), 'use-pactjs-utils'),
      pactMcp: parsePactMcp(getInput('pact-mcp', env)),
      extraArgs: parseExtraArgs(getInput('extra-args', env)),
    },
    comment: getBooleanInput('comment', env),
    uploadReport: getBooleanInput('upload-report', env),
    token: getInput('github-token', env),
    apiUrl: getInput('github-api-url', env) || 'https://api.github.com',
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
  };
}

/**
 * Post the verdict. Never throws: the verdict is the step's exit code, and a
 * comment that could not be written must not turn a failing review green or a
 * passing one red.
 */
async function publishComment(opts, verdict, reviewResult, env = process.env) {
  if (!opts.comment) return;

  const repo = parseRepository(env);
  const prNumber = resolvePrNumber(readEventPayload(env), env);
  if (!repo || prNumber == null) {
    log('No pull request in context, so there is nothing to comment on.');
    return;
  }
  if (!opts.token) {
    warn('comment is enabled but github-token is empty, so the verdict was not published.');
    return;
  }

  const body = buildCommentBody({
    verdict,
    reportText: readTextIfPresent(path.join(opts.workspace, opts.reportPath)),
    runUrl: workflowRunUrl(env),
    reportPath: opts.reportPath,
    reviewResult,
    focus: opts.cli?.focus,
    // The name the composite action's upload step uses; a test pins the two
    // constructions to match, because the comment promises this artifact.
    artifactName: opts.uploadReport && env.GITHUB_JOB ? `tea-test-review-${env.GITHUB_JOB}` : null,
  });

  try {
    const note = await upsertComment(
      { owner: repo.owner, repo: repo.repo, token: opts.token, apiUrl: opts.apiUrl },
      prNumber,
      body
    );
    log(`${note} the review comment on #${prNumber}.`);
  } catch (err) {
    warn(
      `Could not publish the review comment: ${err.message}. ` +
        'The verdict is unaffected; it is this step\'s exit code. Check that the job grants pull-requests: write.'
    );
  }
}

async function run() {
  const payload = readEventPayload();
  const trigger = resolveTrigger({
    mode: parseMode(getInput('mode')),
    mentions: parseMentions(getInput('prompt')),
    agentInput: getInput('agent') || 'claude',
    payload,
    eventName: process.env.GITHUB_EVENT_NAME,
  });
  if (!trigger.proceed) {
    notice(`TEA Test Review not triggered: ${trigger.reason}.`);
    setOutput('skipped', 'true');
    return 0;
  }

  const opts = buildOptions(process.env, {
    agentOverride: trigger.agent,
    agentSwitched: trigger.agentSwitched,
    focus: trigger.focus,
  });
  opts.baseRef = await resolveRunBaseRef(opts, payload);

  log(`TEA Test Review: ${TEA_PACKAGE}@${opts.teaVersion}, agent ${opts.agent.key} (${opts.agent.packageSpec})`);
  log(`  base ref: ${opts.baseRef}, credential: ${opts.credential.name}`);
  if (trigger.via === 'mention') {
    log(`  triggered by a "${trigger.mention}" comment${trigger.focus ? `, focus: ${trigger.focus}` : ''}`);
  }
  if (trigger.agentSwitched) {
    log(`  the mention selected ${trigger.agent}: model and agent-args reset to that vendor's pinned defaults`);
  }
  if (!opts.agent.verified) {
    warn(
      `Agent "${opts.agent.key}" is not a built-in vendor. It runs as --agent claude --agent-cmd ${opts.agent.command}, ` +
        "so the review CLI spawns it with claude's argv (-p --output-format text --tools ... --safe-mode) and the " +
        'prompt on stdin, and it fails as an agent error unless that CLI accepts the same grammar. Prove it with a ' +
        'live run before requiring this as a gate. Built-in agents (claude, codex) do not get this warning.'
    );
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-review-skill-'));
  const { skillRoot, tarballPath } = installSkill(opts.teaVersion, tmpRoot);
  log(`Skill unpacked outside the checkout at ${skillRoot}`);

  runCommandChecked(binaryName('npm'), ['install', '--global', tarballPath, opts.agent.packageSpec]);

  agentLogin(opts.agent, opts.credential);

  const args = buildCliArgs({
    ...opts.cli,
    baseRef: opts.baseRef,
    skillRoot,
    reportPath: opts.reportPath,
    jsonPath: opts.jsonPath,
    cliAgent: opts.agent.cliAgent,
    agentCommand: opts.agent.command,
    envPass: opts.agent.needsEnvPass ? opts.credential.name : '',
  });

  const status = runCommand(binaryName('tea-test-review'), args, {
    cwd: opts.workspace,
    env: childEnv(opts.credential),
  });

  const verdict = readJsonIfPresent(path.join(opts.workspace, opts.jsonPath));
  for (const [name, value] of Object.entries(outputsFromVerdict(verdict))) setOutput(name, value);
  setOutput('report-path', opts.reportPath);
  setOutput('json-path', opts.jsonPath);

  const meaning = EXIT_MEANING[status] || `unexpected exit code ${status}`;
  await publishComment(opts, verdict, `exit ${status} (${meaning})`);

  if (status === 0) {
    if (verdict?.skipped) notice(`Review skipped: ${verdict.reason ?? 'no changed test files'}.`);
    else if (verdict?.waived) notice(`Verdict failure waived: ${verdict.waiveReason ?? 'no reason recorded'}.`);
    else log(`Review passed: ${verdict?.recommendation ?? 'no verdict recorded'}.`);
    return 0;
  }

  // Exit 2 and 3 are not verdicts. Saying so in the log matters because the
  // difference is between tests that need work and a gate that did not run.
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
  AGENTS,
  COMMENT_MARKER,
  MAX_INLINE_REPORT_CHARS,
  MAX_LISTED_REVIEWED_FILES,
  fenceLeadingFrontmatter,
  getInput,
  getBooleanInput,
  setOutput,
  binaryName,
  resolveBaseRef,
  resolveRunBaseRef,
  MENTION_TRUSTED_ASSOCIATIONS,
  MAX_FOCUS_LENGTH,
  parseMode,
  parseMentions,
  matchMention,
  extractFocus,
  agentForMention,
  resolveTrigger,
  parseTriState,
  parsePactMcp,
  parseExtraArgs,
  resolveAgent,
  resolveCredential,
  agentLogin,
  childEnv,
  buildCliArgs,
  packedTarballName,
  assertShipsCli,
  outputsFromVerdict,
  buildCommentBody,
  findOwnComment,
  resolvePrNumber,
  parseRepository,
  workflowRunUrl,
  isRetryableStatus,
  installSkill,
  githubRequest,
  upsertComment,
  buildOptions,
};
