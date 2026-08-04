# tea-test-review

`tea-test-review` runs the headless [TEA test-quality review](https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-test-review/)
against a pull request's changed test files, fails the step on the review
verdict, publishes the full report as one upserted PR comment, and uploads the
report as a run artifact. It carries no third-party JavaScript dependencies;
the only actions it uses are GitHub's own.

It packages what used to be a ~230-line workflow copied into every repository:
pin and unpack the review skill from an npm tarball, install the pinned CLI and
agent, run `tea-test-review`, then comment. One step replaces both jobs.

Use `@v1` for the latest backwards-compatible v1 release. Pin a full commit SHA
when the caller requires an immutable dependency and deliberate upgrades.

## Installation

Copy one of the two [proven configurations](#proven-configurations) below. Both
ran live end to end, so neither is an illustration.

Two things any such workflow needs and will not work without:

- `pull-requests: write`, when `comment` is left on.
- A credential. Either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, as the
  step's `env:` above or as the `anthropic-api-key` / `claude-code-oauth-token`
  inputs. `ANTHROPIC_API_KEY` bills per token through the Anthropic Console.
  `CLAUDE_CODE_OAUTH_TOKEN` is a long-lived token minted from an existing Claude
  subscription with `claude setup-token`, with no separate API billing.

There is no checkout step on purpose: the action checks out the code itself —
full history, the PR's merge commit — so the review always diffs the right
tree. Node 22 or newer is installed on GitHub-hosted runners already, so no
`setup-node` step is required either.

### `tea-version` has to be a version that ships the CLI

`bmad-method-test-architecture-enterprise@1.20.0` is the first release that does.
Every earlier version publishes the review _skill_ and declares an empty `bin`,
and npm versions are immutable, so those will not gain it later.

The default is `latest`, so a fresh caller gets a release that ships the CLI
without pinning anything. The action still checks the unpacked tarball's
`package.json` before installing anything and fails with that explanation,
rather than letting the run die on `tea-test-review not found on PATH` two
installs later.

Pin an exact version when you want the verdict to be reproducible:

```yaml
with:
  tea-version: "1.20.0"
```

## Proven configurations

Both workflows below ran live against real pull requests, end to end: install,
review, gate exit code, upserted PR comment, uploaded artifact. They are shown
verbatim; the job skeleton is identical and only the `with:` block differs.
Both predate the action's built-in checkout, so their `actions/checkout` steps
are redundant today — harmless, but new installs should not add one.

### Claude

The workflow that reviewed a private TypeScript repository whose tests live
under `scripts/`:

```yaml
name: TEA Test Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

# Deny-all baseline for GITHUB_TOKEN. Not the same as omitting the key, which
# falls back to the repository default; each job opts back in below.
permissions: {}

jobs:
  review:
    name: test review
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # Forks receive no secrets, so the review cannot run for them.
    if: github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      pull-requests: write # for the review comment
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the review diffs changed test files against the base ref
          persist-credentials: false

      - uses: muratkeremozcan/tea-test-review@main
        with:
          agent: claude
          model: claude-sonnet-4-6
          anthropic-api-key: ${{ secrets.CLAUDE_REVIEW_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          use-playwright-utils: "true"
          use-pactjs-utils: "true"
```

- `CLAUDE_REVIEW_TOKEN` is only the secret's name in that repository; any
  Anthropic Console key works. The `anthropic-api-key` input and an
  `ANTHROPIC_API_KEY` env on the step are interchangeable.
- `github-token` is spelled out for readability; it equals the default.
- `use-playwright-utils` and `use-pactjs-utils` are stated rather than left to
  resolve. CI installs the skill from a tarball, so no `_bmad/tea/config.yaml`
  exists, and an unstated key is one the agent settles per run: identical
  files then get reviewed against different knowledge.

### Codex

The file that gated
[couture-cast#101](https://github.com/muratkeremozcan/couture-cast/pull/101).
codex reviewed a deliberately poor API spec, returned `Request Changes` with
76/100, grade C, and the step exited 1, which is the gate working, not the
integration failing:

```yaml
name: TEA Test Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

# Deny-all baseline for GITHUB_TOKEN. Not the same as omitting the key, which
# falls back to the repository default; each job opts back in below.
permissions: {}

jobs:
  review:
    name: test review
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # Forks receive no secrets, so the review cannot run for them.
    if: github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      pull-requests: write # for the review comment
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the review diffs changed test files against the base ref
          persist-credentials: false

      - uses: muratkeremozcan/tea-test-review@main
        with:
          agent: codex
          model: gpt-5.6-luna
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          use-playwright-utils: "true"
          use-pactjs-utils: "true"
          agent-args: -c model_reasoning_effort=low
```

- codex needs two setup steps claude does not, and the action performs both:
  the `codex login --with-api-key` pipe and the Linux user-namespace fix, both
  described under "Other agents".
- `agent-args: -c model_reasoning_effort=low` is a Codex-only knob, forwarded
  through the review CLI's `--agent-arg`. Measured locally it cuts a full
  review from ~10 minutes to ~3.5; the gated run above finished in about a
  minute.
- No `test-dir`: it is only a hint to the skill, the review set always comes
  from the pull-request diff, and this repository's tests live under
  `playwright/tests`.

Both pin `model` as a fully-qualified slug rather than the review CLI's alias
defaults (`sonnet`, `gpt-5.6-sol`): a verdict stays attributable to one model
generation, and the slug that ran is recorded in the verdict JSON next to
`agent`.

## Trigger the review from a PR comment

`mode` and `prompt` are the whole surface. `mode: auto` (the default) is what
the recipes above do: every pull request, plus a mention comment when the
workflow also triggers on `issue_comment`. `mode: manual` reviews only when
asked — `pull_request` events skip cleanly. Either way the mention picks the
agent, and whatever the requester wrote after it becomes the review's focus:

```text
@codex focus on the retry paths
```

```yaml
name: TEA Test Review

on:
  pull_request: # delete this block for mention-only reviews
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions: {}

jobs:
  review:
    name: test review
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # The fork guard is only for the pull_request path; the mention path is
    # gated inside the action.
    if: github.event_name == 'issue_comment' || github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      pull-requests: write # for the review comment
    steps:
      - uses: muratkeremozcan/tea-test-review@<sha>
        with:
          prompt: "@claude @codex"
          agent: codex
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

- **The mention picks the agent.** `@codex` runs codex, `@claude` runs claude,
  and a mention naming no built-in vendor keeps the `agent` input. A mention
  that switches vendors resets `model` and `agent-args` to the selected
  vendor's pinned defaults, because the configured values belong to the
  configured vendor and would not parse. `pull_request` runs always use the
  `agent` input.
- **Text after the mention is the review's focus.** It reaches the reviewer as
  a focus note, capped at 1000 characters: it may raise scrutiny on what it
  names and can never waive a finding. The report quotes it as a `**Focus**:`
  line, so a score states what steered it. This needs a tea-version whose CLI
  understands
  `--focus`; on an older one the run fails with an unknown-option error. If
  the PR changed no test files the review still skips — a focus note does not
  invent a review set — but the skip comment quotes what you asked for and
  says what changed instead, so the mention never reads as unheard.
- **The authorization bar is enforced by the action, not your YAML.** Only a
  comment from an OWNER, MEMBER or COLLABORATOR — never a bot — on a pull
  request triggers the review; anything else skips cleanly with no comment
  posted. An `issue_comment` run executes with the base repository's secrets
  and checks out the PR's code, so that gate is what stands between a stranger
  and your API key on a public repository.
- **Checkout and base ref are handled.** On an `issue_comment` run the action
  checks out the PR's merge ref itself and resolves the base branch through
  the pulls API. Do not add a checkout step.

Only the selected agent's credential is required. An unset secret resolves to
empty and is ignored by the agent that does not use it, so a claude-only
repository can leave `openai-api-key` out.

## Failing CI on a bad review

**It already does.** The CLI defaults to `--fail-on request-changes`, so a
`Request Changes` or `Block` verdict exits the step non-zero and the job goes red
with no configuration at all.

The comment is posted **before** the gate fails, so a red job never costs you the
review. If you want the finding, read the comment; the exit code is only the
verdict.

| Exit | Meaning                                                                |
| ---: | ---------------------------------------------------------------------- |
|  `0` | Verdict passed, the review was skipped, or a failure was waived        |
|  `1` | Verdict failure. The tests need work                                   |
|  `2` | Environment or configuration error. **No review happened**             |
|  `3` | Agent or report-parse failure. **No review happened**                  |

`2` and `3` are not verdicts. The action says so in the log and in the comment,
and never reports either as approved tests. Treat them as a broken gate, not as
passing tests.

### Choose how much the verdict blocks

**Blocking, individually required.** Add the job to the branch ruleset by name.
The most direct option, and the right one when this is your only quality gate.

**Blocking through an aggregating gate.** If the repository already publishes one
required status that waits on every workflow, this job needs no ruleset entry of
its own: its red job fails that status, and that status blocks the merge. Verify
this shape before adding a second required check you do not need.

**Advisory.** `continue-on-error: true` on the job keeps a failing verdict a
comment and never a red pipeline. Useful while a team is calibrating to the
rubric, or when the test review rides along beside a code review that owns the
gate. You give up enforcement completely: nothing stops a merge, so this is a
reporting tool until you remove the line.

```yaml
jobs:
  tea-review:
    runs-on: ubuntu-latest
    continue-on-error: true # advisory: verdict is a comment, never a red pipeline
    steps:
      - uses: muratkeremozcan/tea-test-review@v1
        # ...
```

### Tune the strictness

```yaml
with:
  fail-on: block # let Request Changes pass; fail only on Block
  min-score: "80" # also fail below a score floor
  min-files: "2" # also fail when the report reviewed fewer files than this
```

`min-score` and `min-files` are off unless set. `fail-on` is the exception: left
empty, the CLI's own `request-changes` default applies, which is why this gate
bites out of the box. `fail-on: block` is the loosest useful setting — the review
still runs and still comments, and only a `Block` stops the merge.

`min-files` counts the report's own manifest, not the diff, so it is an evidence
floor: it catches a review that quietly scoped itself down to one file.

**No setting lets a Critical finding pass.** A Critical violation means a test
cannot fail or never reaches the code it claims to test, and the review derives
`Block` for it, which fails at every `fail-on` level. `max-critical` can tighten
the gate and never widen it. When you genuinely need to ship past one, use
`--waive` through `extra-args`: it changes the exit code, is recorded in the
verdict payload with its reason and expiry, and leaves the verdict itself intact
so the finding stays visible.

A pull request that changes no test file **skips and exits 0**, which a required
check reads as passing. Read the `skipped` output to tell a skip from a pass, or
pass `--fail-on-skip` through `extra-args` to make a skip fail instead.

### Forks give no protection

Fork pull requests get no secrets, so the review cannot run for them. This
matters more than it looks: GitHub treats a skipped required check as passing, so
a gate that skips on forks gives **zero** protection against external
contributions. It is the contributions you trust least that go unreviewed.

Guard the job with
`if: github.event.pull_request.head.repo.full_name == github.repository` and pair
the gate with something that does cover forks. Fork coverage needs a privileged
design of its own, such as a `pull_request_target` workflow with strict controls.

## Artifacts

The action uploads `report-path` and `json-path` itself, as the
`tea-test-review-<job>` artifact on the workflow run, on every run including a
failed verdict. A report too large to inline in the PR comment is therefore
still recoverable after the runner is deleted; the comment says which artifact
holds it. Opt out with `upload-report: 'false'` and manage artifacts yourself.

## Configuration

Every input and default is documented in [`action.yml`](action.yml). This section
covers only the ones with a consequence you would not guess. Gate policy
(`fail-on`, `min-score`, `max-critical`, `min-files`) is in
[Failing CI on a bad review](#failing-ci-on-a-bad-review).

Review scope: `base-ref` (derived from the event, or through the pulls API on
an `issue_comment` run, so a pull request into a release branch diffs against
that branch), `test-dir`, `scope`.

Which model reviews: `model`. Left empty the review CLI applies its own
per-vendor pinned default (`claude`: `sonnet`, `codex`: `gpt-5.6-sol`), so a run
here and a run on a laptop use the same reviewer. This input picks a different
one; it does not decide whether a model is pinned.

```yaml
with:
  agent: codex
  model: gpt-5.6-sol
```

Set it when the default tier is wrong for your suite, or pin a fully-qualified
slug when a verdict has to be reproducible across model generations: the
defaults are aliases that follow the vendor's current model in that tier. The
model that actually ran comes back in the verdict JSON as `model`, next to
`agent`, because two scores are only comparable when both match.

Selected-agent configuration goes through `agent-args`. The value is parsed as
a shell-style argument list, then each token is forwarded in order through the
review CLI's `--agent-arg` option. For a faster Codex review:

```yaml
with:
  agent: codex
  model: gpt-5.6-luna
  agent-args: -c model_reasoning_effort=low
```

TEA config keys: `use-playwright-utils`, `use-pactjs-utils`, `pact-mcp`. Set
`use-pactjs-utils: 'true'` in a repository that does contract testing:

```yaml
with:
  use-pactjs-utils: "true"
  pact-mcp: mcp
```

Left empty they resolve the way the CLI resolves them, which for CI means the
module default, because a tarball install writes no `_bmad/tea/config.yaml`.
Playwright Utils is on, `pactjs-utils` is off, and Pact MCP is none. A
contract-testing repository that leaves `use-pactjs-utils` empty gets the generic
contract-testing fragment instead of the `pactjs-utils` set and will not be
flagged for a missing determinism gate.

Anything not modelled goes through `extra-args` verbatim, quoted like a shell
argument list:

```yaml
with:
  extra-args: --waive "flaky suite, FP-1234" --waive-until 2026-09-30
```

That covers `--files`, `--test-glob`, `--timeout-ms`, `--fail-on-skip`,
`--waive`/`--waive-until`, `--isolate`/`--no-isolate` and `--env-pass`.
Arguments land after the modelled flags, so `extra-args` wins on a repeated
flag. Use `agent-args` for selected-agent configuration. See the
[full CLI flag reference](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/blob/main/docs/reference/tea-test-review-cli.md).

## Outputs

| Output                              | Value                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `recommendation`                    | `Approve`, `Approve with Comments`, `Request Changes` or `Block`. Empty on a skip. |
| `quality-score`                     | Score out of 100. Empty on a skip.                                                 |
| `critical`, `high`, `medium`, `low` | Violation counts.                                                                  |
| `reviewed-files`                    | How many files the report says it reviewed.                                        |
| `skipped`                           | `true` when there were no changed test files.                                      |
| `report-path`, `json-path`          | Workspace-relative paths of the report and verdict.                                |

## Other agents

`agent` defaults to `claude`. `codex` is also built in and its full proven
workflow is the second configuration above: the review CLI's own adapter table
([`cli/lib/agent-adapters.js`](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/blob/main/cli/lib/agent-adapters.js))
spawns it natively (`codex exec --sandbox workspace-write`), so this action
passes `agent` straight through as `--agent` and installs `@openai/codex`,
pinned by `codex-version`.

codex needs two things claude does not, and this action does both for you.
First, authentication: codex 0.146.0 never reads `OPENAI_API_KEY` from the
environment and authenticates only from `~/.codex/auth.json`, which no runner
has. Handed only the variable, it sends no credential at all and the run dies
on `401 ... Missing bearer or basic authentication in header`. So before
running the review, the action pipes your key into `codex login
--with-api-key` on stdin, never argv, so the credential reaches disk without
reaching the workflow log. Second, its sandbox: on GitHub-hosted Linux, codex
isolates itself with bubblewrap, which needs unprivileged user namespaces that
Ubuntu 24.04 restricts, and without them every codex command fails with
`loopback: Failed RTM_NEWADDR`. The action enables them
(`kernel.unprivileged_userns_clone=1`,
`kernel.apparmor_restrict_unprivileged_userns=0`) before installing anything,
and skips that step on any other OS or a self-hosted runner.

Any other value is a genuinely custom vendor and needs `agent-package`, and
usually `agent-command` and `agent-key-env`, so adding one needs no change
here:

```yaml
with:
  agent: gemini
  agent-package: "@google/gemini-cli@0.5.0"
  agent-command: gemini
  agent-key-env: GEMINI_API_KEY
  agent-api-key: ${{ secrets.GEMINI_API_KEY }}
```

The ceiling is not in this action. The review CLI's own `--agent` flag only
accepts `claude`, `codex` or `none`, so a custom vendor runs by impersonating
claude's protocol through `--agent-cmd`: TEA's `cli/lib/run-agent.js` builds a
fixed argv for the claude adapter (`-p --output-format text --tools
Read,Write,Edit,Glob,Grep --allowedTools ... --safe-mode --model <model>`) and
delivers the prompt on stdin, so the custom executable has to accept that same
grammar, `--model` included.
When it does not, the run fails as an agent error (exit 3). The action warns
on any unproven vendor. Prove one with a live run before requiring it as a
gate.

`agent-key-env` is not optional for a custom vendor. The CLI hands the agent a
minimal environment and drops every variable it was not told to pass, so an
unnamed credential never reaches the agent at all. `claude` and `codex` do not
need it: both credentials are already covered by the CLI's own base
environment / adapter `envNames`. Note that a custom vendor which likewise
ignores its key variable, as codex does, cannot be fixed with `agent-key-env`
alone; only built-in vendors get the login step described above.

## Important behavior

- **The reviewer never comes from the pull request.** The skill is unpacked from
  the pinned npm tarball into a temp directory outside the checkout and passed as
  `--skill-root`, so a pull request that edits its own vendored `_bmad/` copy
  cannot rewrite the reviewer that judges it. The residual trust is the pinned
  version as published: vet it once, pin it exactly, bump it deliberately.
- **A TEA version that ships no CLI fails before installing anything.** See
  above. The default of `latest` cannot hit that case on its own; an explicit
  pin below 1.20.0 can.
- **The agent versions stay pinned, and `tea-version` defaults to `latest`.**
  `claude-code-version` and `codex-version` are exact because a vendor CLI
  changes its own behaviour under you. `tea-version` follows the newest release
  so callers do not carry a bump, which trades reproducibility for currency:
  pin it when a verdict has to be reproducible.
- **The comment is upserted on a hidden marker**, so ten pushes update one
  comment instead of leaving ten. A comment that cannot be written is a warning
  and never changes the verdict, because the verdict is the step's exit code.
- **A review takes minutes.** The CLI prints a heartbeat every 15 seconds and
  this action streams it straight through, so a live job shows progress rather
  than looking hung. Give the job a `timeout-minutes` that accommodates it.

## Releasing

**Actions → Release → Run workflow** on `main`, choose `patch`/`minor`/`major`.
The workflow runs the unit suite and a consumer smoke, derives the `vX.Y.Z` tag,
and drafts a release. Review the draft, tick **Publish this Action to the GitHub
Marketplace**, publish. The publication job then moves the floating major tag
(`v1`) to the same commit.

Exact release tags are permanent under repository immutability. Floating major
tags carry no GitHub release, because they have to move.

## Development

```bash
node --test tests/*.test.js
```

No dependency installation. The action is composite: `main.js` on Node 24 pinned
with `actions/setup-node`, plus `actions/checkout` and `actions/upload-artifact`
— all GitHub's own.

Unit tests stub the `fetch` and child-process boundaries. What they cannot reach
is covered by the `Test` workflow's `smoke` job, which unpacks the real tarball,
installs the pinned CLI, reviews this repository's own test file, and comments
twice to prove the second run updates rather than duplicates. It reports itself
skipped rather than red when no credential is present.
