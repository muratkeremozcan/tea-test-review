# tea-test-review

`tea-test-review` runs the headless [TEA test-quality review](https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-test-review/)
against a pull request's changed test files, fails the step on the verdict,
publishes the report as one upserted PR comment, and uploads it as a run
artifact. No third-party JavaScript dependencies; the only actions it uses
are GitHub's own.

It replaces a ~230-line workflow that used to be copied into every repository
(unpack the review skill from an npm tarball, install the pinned CLI and
agent, run, comment) with one step.

Use `@v1` for the latest backwards-compatible v1 release. Pin a full commit
SHA when the caller requires an immutable dependency and deliberate upgrades.

## Installation

Copy one of the two [proven configurations](#proven-configurations) below;
both ran live end to end against real pull requests. Two requirements:

- `pull-requests: write`, when `comment` is left on.
- A credential: `ANTHROPIC_API_KEY` (bills per token through the Anthropic
  Console) or `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from
  `claude setup-token`, billed to an existing Claude subscription), as the
  step's `env:` or as the matching inputs.

Add no checkout step: the action checks out the code itself, full history at
the PR's merge commit. GitHub-hosted runners already have Node 22+, so no
`setup-node` step either.

### `tea-version` has to ship the CLI

`bmad-method-test-architecture-enterprise@1.20.0` is the first release that
does; earlier ones publish the review skill with an empty `bin`, and npm
versions are immutable. The default is `latest`, which already resolves to a
CLI-shipping release. The action checks the unpacked tarball before
installing anything, so a bad pin fails with that explanation instead of
`tea-test-review not found on PATH` two installs later.

Pin an exact version when the verdict has to be reproducible:

```yaml
with:
  tea-version: "1.20.0"
```

## Proven configurations

Both workflows ran live against real pull requests, end to end: install,
review, gate exit code, upserted comment, uploaded artifact. Shown verbatim;
only the `with:` block differs. Both predate the action's built-in checkout,
so their `actions/checkout` steps are redundant today.

### Claude

Reviewed a private TypeScript repository whose tests live under `scripts/`:

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

- `CLAUDE_REVIEW_TOKEN` is just that repository's secret name; any Anthropic
  Console key works, as the input or an `ANTHROPIC_API_KEY` env.
- `github-token` is spelled out for readability; it equals the default.
- The utils keys are stated rather than left to resolve: CI installs the
  skill from a tarball, so no `_bmad/tea/config.yaml` exists, and an unstated
  key is one the agent settles per run. Identical files would get reviewed
  against different knowledge.

### Codex

The file that gated
[couture-cast#101](https://github.com/muratkeremozcan/couture-cast/pull/101):
codex reviewed a deliberately poor API spec, returned `Request Changes` with
76/100, grade C, and the step exited 1.

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

- codex needs two setup steps claude does not; the action performs both
  ([Other agents](#other-agents)).
- `agent-args` forwards to codex through the review CLI's `--agent-arg`.
  `model_reasoning_effort=low` cut a full review from ~10 minutes to ~3.5
  measured locally; the gated run above finished in about a minute.
- No `test-dir`: the review set always comes from the pull-request diff.

Both pin `model` as a fully-qualified slug rather than the CLI's alias
defaults (`sonnet`, `gpt-5.6-sol`), so a verdict stays attributable to one
model generation. The slug that ran is recorded in the verdict JSON next to
`agent`.

## Trigger the review from a PR comment

`mode` and `prompt` are the whole surface. `mode: auto` (the default) is the
recipes above: every pull request, plus a mention comment when the workflow
also triggers on `issue_comment`. `mode: manual` reviews only when asked, and
`pull_request` events skip cleanly. Either way the mention picks the agent,
and the text after it becomes the review's focus:

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

- `@codex` runs codex, `@claude` runs claude; any other mention keeps the
  `agent` input. Switching vendors resets `model` and `agent-args` to the
  selected vendor's pinned defaults, since the configured values would not
  parse for the new vendor. `pull_request` runs always use the `agent` input.
- The focus text reaches the reviewer capped at 1000 characters; it may raise
  scrutiny on what it names and can never waive a finding. The report quotes
  it as a `**Focus**:` line. Requires a tea-version whose CLI understands
  `--focus`. A PR with no changed test files still skips, but the skip
  comment quotes what you asked for and says what changed instead.
- Only a comment from an OWNER, MEMBER or COLLABORATOR (never a bot) on a
  pull request triggers the review, and the action enforces that itself. An
  `issue_comment` run executes with the base repository's secrets and checks
  out the PR's code, so this gate is what stands between a stranger and your
  API key on a public repository.
- On `issue_comment` runs the action checks out the PR's merge ref and
  resolves the base branch through the pulls API; add no checkout step.

Only the selected agent's credential is required; an unset secret resolves to
empty and is ignored, so a claude-only repository can leave `openai-api-key`
out.

## Failing CI on a bad review

It already does: the CLI defaults to `--fail-on request-changes`, so a
`Request Changes` or `Block` verdict exits the step non-zero with no
configuration. The comment posts before the gate fails, so a red job never
costs you the review.

| Exit | Meaning                                                                |
| ---: | ---------------------------------------------------------------------- |
|  `0` | Verdict passed, the review was skipped, or a failure was waived        |
|  `1` | Verdict failure. The tests need work                                   |
|  `2` | Environment or configuration error. **No review happened**             |
|  `3` | Agent or report-parse failure. **No review happened**                  |

`2` and `3` mean no review happened; the action says so in the log and in
the comment, and never reports either as approved tests.

### Choose how much the verdict blocks

- Add the job to the branch ruleset by name when this is your only quality
  gate.
- If the repository already publishes one required status that waits on
  every workflow, this job needs no entry of its own: its failure fails that
  status. Verify this shape before adding a second required check you do not
  need.
- `continue-on-error: true` keeps a failing verdict a comment and never a
  red pipeline, while a team calibrates or a code review owns the gate.
  Nothing stops a merge in this mode.

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

`min-score` and `min-files` are off unless set; `fail-on` left empty falls
through to the CLI's `request-changes` default, which is why the gate works
unconfigured. `min-files` counts the report's own manifest rather than the
diff, so it catches a review that quietly scoped itself down to one file.

A Critical violation means a test cannot fail or never reaches the code it
claims to test, so the review derives `Block`, which fails at every `fail-on`
level. `max-critical` can only tighten the gate. To ship past a Critical, use
`--waive` through `extra-args`: it changes the exit code, is recorded in the
verdict payload with reason and expiry, and leaves the verdict intact so the
finding stays visible.

A pull request that changes no test file skips and exits 0, which a required
check reads as passing. Read the `skipped` output to tell a skip from a pass,
or pass `--fail-on-skip` through `extra-args`.

### Forks give no protection

Fork pull requests get no secrets, so the review cannot run for them, and
GitHub treats a skipped required check as passing: a gate that skips on forks
gives zero protection against external contributions. Guard the job as the
recipes above do, and pair the gate with something that covers forks, such as
a `pull_request_target` workflow with strict controls.

## Artifacts

`report-path` and `json-path` upload as the `tea-test-review-<job>` artifact
on every run, including a failed verdict, so a report too large to inline
survives the runner's deletion; the comment says which artifact holds it.
Opt out with `upload-report: 'false'`.

## Configuration

Every input and default is documented in [`action.yml`](action.yml). The ones
with a consequence you would not guess:

- `base-ref` derives from the event, or through the pulls API on an
  `issue_comment` run, so a pull request into a release branch diffs against
  that branch.
- `use-playwright-utils`, `use-pactjs-utils`, `pact-mcp`: state them in CI,
  where a tarball install writes no `_bmad/tea/config.yaml`. Empty resolves
  to the module default (Playwright Utils on, `pactjs-utils` off, Pact MCP
  none). A contract-testing repository that leaves `use-pactjs-utils` empty
  gets the generic contract-testing fragment instead of the `pactjs-utils`
  set, and is never flagged for a missing determinism gate.
- `agent-args` is a shell-style list forwarded in order through the CLI's
  `--agent-arg`, for vendor knobs like Codex `-c model_reasoning_effort=low`
  above.
- `extra-args` is anything not modelled, appended verbatim after the
  modelled flags, so it wins on a repeated flag:

```yaml
with:
  extra-args: --waive "flaky suite, FP-1234" --waive-until 2026-09-30
```

That covers `--files`, `--test-glob`, `--timeout-ms`, `--fail-on-skip`,
`--waive`/`--waive-until`, `--isolate`/`--no-isolate` and `--env-pass`. See
the
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

`agent` defaults to `claude`. `codex` is built in: the CLI's adapter table
([`cli/lib/agent-adapters.js`](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/blob/main/cli/lib/agent-adapters.js))
spawns it natively (`codex exec --sandbox workspace-write`), so the action
passes `agent` straight through as `--agent` and installs `@openai/codex`,
pinned by `codex-version`.

codex needs two things claude does not, and the action does both. codex
0.146.0 never reads `OPENAI_API_KEY` from the environment and authenticates
only from `~/.codex/auth.json`, which no runner has; handed only the
variable, the run dies on
`401 ... Missing bearer or basic authentication in header`. The action pipes
the key into `codex login --with-api-key` on stdin, never argv, so the
credential reaches disk without reaching the workflow log. And on
GitHub-hosted Linux, codex's bubblewrap sandbox needs unprivileged user
namespaces that Ubuntu 24.04 restricts; without them every command fails
with `loopback: Failed RTM_NEWADDR`, so the action enables them
(`kernel.unprivileged_userns_clone=1`,
`kernel.apparmor_restrict_unprivileged_userns=0`) before installing, skipping
that step on any other OS or a self-hosted runner.

Any other value is a custom vendor and needs `agent-package`, and usually
`agent-command` and `agent-key-env`:

```yaml
with:
  agent: gemini
  agent-package: "@google/gemini-cli@0.5.0"
  agent-command: gemini
  agent-key-env: GEMINI_API_KEY
  agent-api-key: ${{ secrets.GEMINI_API_KEY }}
```

The ceiling sits in the review CLI, whose `--agent` accepts only `claude`,
`codex` or `none`: a custom vendor impersonates claude's protocol through
`--agent-cmd`, so its executable must accept claude's fixed argv
(`-p --output-format text --tools ... --safe-mode --model <model>`) with the
prompt on stdin, or the run fails as an agent error (exit 3). The action
warns on an unproven vendor; prove one with a live run before requiring it
as a gate.

A custom vendor must set `agent-key-env`: the CLI hands the agent a minimal
environment and drops every variable it was not told to pass, so an unnamed
credential never arrives. `claude` and `codex` are covered by the CLI's base
environment and adapter `envNames`. A vendor that ignores its key variable
the way codex does cannot be fixed with `agent-key-env` alone; only built-in
vendors get the login step above.

## Important behavior

- The review skill is unpacked from the pinned npm tarball into a temp
  directory outside the checkout and passed as `--skill-root`, so a pull
  request that edits its own vendored `_bmad/` copy cannot rewrite the
  reviewer that judges it. The residual trust is the pinned version as
  published: vet it once, pin it exactly, bump it deliberately.
- `claude-code-version` and `codex-version` are exact pins because a vendor
  CLI changes its own behaviour under you; `tea-version` follows the newest
  release so callers do not carry a bump.
- The comment is upserted on a hidden marker, so ten pushes update one
  comment. A comment that cannot be written is a warning and never changes
  the verdict.
- The CLI prints a heartbeat every 15 seconds, streamed straight through, so
  a live job shows progress rather than looking hung. Give the job a
  `timeout-minutes` that accommodates a multi-minute review.

## Releasing

**Actions → Release → Run workflow** on `main`, choose
`patch`/`minor`/`major`. The workflow runs the unit suite and a consumer
smoke, derives the `vX.Y.Z` tag, and drafts a release. Review the draft,
tick **Publish this Action to the GitHub Marketplace**, publish. The
publication job then moves the floating major tag (`v1`) to the same commit.

Exact release tags are permanent under repository immutability. Floating
major tags carry no GitHub release, because they have to move.

## Development

```bash
node --test tests/*.test.js
```

No dependency installation. The action is composite: `main.js` on Node 24
pinned with `actions/setup-node`, plus `actions/checkout` and
`actions/upload-artifact`, all GitHub's own.

Unit tests stub the `fetch` and child-process boundaries. What they cannot
reach is covered by the `Test` workflow's `smoke` job, which unpacks the real
tarball, installs the pinned CLI, reviews this repository's own test file,
and comments twice to prove the second run updates rather than duplicates.
It reports itself skipped rather than red when no credential is present.
