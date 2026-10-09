# tea-test-review

`tea-test-review` runs the headless [TEA test-quality review](https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-test-review/)
against a pull request's changed test files, fails the step on the verdict,
publishes a short comment and a check run, and uploads the report as a run
artifact. No third-party JavaScript dependencies; the only actions it uses
are GitHub's own.

The action is a GitHub convenience over the `tea-test-review` CLI, which owns
the review: the packaged skill, the retry, the pull request base lookup, the
comment and its upsert, and the check run
([CLI reference](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/blob/main/docs/reference/tea-test-review-cli.md)).
The action adds what only GitHub Actions knows: the checkout, the `@mention`
trigger and its trusted-author gate, the `:eyes:` reaction, installing and
logging in the agent CLI, and the artifact upload. Outside GitHub Actions, or
on another CI, run the CLI directly.

Use `@v1` for the latest backwards-compatible v1 release. Pin a full commit
SHA when the caller requires an immutable dependency and deliberate upgrades.

## Installation

Copy one of the two [proven configurations](#proven-configurations) below;
both ran live end to end against real pull requests. Two requirements:

- `pull-requests: write`, when `comment` is left on.
- `checks: write`, when `check-run` is left on. Without it the review is
  invisible on the pull request until it finishes.
- A credential: `ANTHROPIC_API_KEY` (bills per token through the Anthropic
  Console) or `CLAUDE_CODE_OAUTH_TOKEN` (a long-lived token from
  `claude setup-token`, billed to an existing Claude subscription), as the
  step's `env:` or as the matching inputs.

Add no checkout step: the action checks out the code itself, full history at
the PR's merge commit. GitHub-hosted runners already have Node 22+, so no
`setup-node` step either.

### `tea-version` and where the CLI comes from

`tea-version` takes a version or dist-tag of
`bmad-method-test-architecture-enterprise`, a tarball URL, or a path to a
tarball (an `npm pack` of the package). The action installs it globally with
the agent CLI in one step; the CLI carries its own review skill, so the skill
and the CLI are always one version.

The action drives CLI features that older releases do not have: `--github` (the
comment and the check run), `--pr` (the base branch lookup), `--retries`, and
the packaged skill. After installing it runs `tea-test-review --help` and stops
with the version to change when `--github` is missing, instead of an
unknown-option error mid-run. A workflow that pins `tea-version` to a release
without those features now fails there with exit 2; move the pin to a release
whose CLI lists `--github`.

Pin an exact version or a tarball URL when the verdict has to be reproducible:

```yaml
with:
  tea-version: "<a release or tarball whose CLI lists --github>"
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
      checks: write # for the check run that shows the review in the PR's Checks list
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
- The utils keys are stated rather than left to resolve: CI reviews with the
  skill packaged in the CLI, so no `_bmad/tea/config.yaml` exists, and an
  unstated key is one the agent settles per run. Identical files would get
  reviewed against different knowledge.

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
      checks: write # for the check run that shows the review in the PR's Checks list
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

### Dual reviews (Codex & Claude)

Run multiple review steps in the same workflow. For `claude` and `codex`, comments (`<!-- tea-test-review:<agent> -->`) and report artifacts (`tea-test-review-<job>-<agent>`) tag by the `agent` key, so each agent posts its own comment without collision:

```yaml
steps:
  - name: Review with Codex
    uses: muratkeremozcan/tea-test-review@v1
    with:
      prompt: '@codex'
      agent: codex
      model: gpt-5.6-luna
      mode: 'manual'
      agent-args: -c model_reasoning_effort=low
      openai-api-key: ${{ secrets.OPENAI_API_KEY }}
      check-run-name: TEA Test Review (codex)

  - name: Review with Claude
    uses: muratkeremozcan/tea-test-review@v1
    with:
      prompt: '@claude'
      agent: claude
      mode: 'manual'
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      check-run-name: TEA Test Review (claude)
```

That tagging is automatic. A custom vendor runs as `--agent claude`, so its
comment marker and check text carry the `claude` tag and collide with a claude
review on the same pull request; its artifact still tags by the `agent` input.
The check run is matched by name, so two reviews on one pull request need two
different `check-run-name` values, or both post a check run under one name and
the required check reports whichever finished last. Running the same agent twice in
one workflow (e.g. two `codex` steps with different models) is not
disambiguated — the second step's comment and artifact overwrite the first's.

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
      checks: write # for the check run that shows the review in the PR's Checks list
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
  it as a `**Focus**:` line. A PR with no changed test files still skips, but the skip
  comment quotes what you asked for and says what changed instead.
- Only a comment from an OWNER, MEMBER or COLLABORATOR (never a bot) on a
  pull request triggers the review, and the action enforces that itself. An
  `issue_comment` run executes with the base repository's secrets and checks
  out the PR's code, so this gate is what stands between a stranger and your
  API key on a public repository.
- On `issue_comment` runs the action checks out the PR's merge ref (the head
  ref when the PR has conflicts) and the CLI resolves the base branch through
  the pulls API (`--pr`); add no checkout step.
- A recognized mention gets an immediate :eyes: reaction, before the CLI
  runs. Tied to the `comment` input.
- The CLI also opens a check run against the PR's head commit before the
  review starts, so a run in flight is visible in the Checks list for the ten-plus
  minutes it can take. This needs `checks: write`. Without it the run is
  invisible on the PR: an `issue_comment` workflow is repository-scoped, so
  GitHub binds its check suite to the default branch and the PR's Checks list
  shows nothing at all. Tied to the `check-run` input.

Only the selected agent's credential is required; an unset secret resolves to
empty and is ignored, so a claude-only repository can leave `openai-api-key`
out.

## Failing CI on a bad review

It already does: the CLI defaults to `--fail-on request-changes`, so a
`Request Changes` or `Block` verdict exits the step non-zero with no
configuration. The comment is published before the step fails, so a red job
never costs you the review.

| Exit | Meaning                                                                |
| ---: | ---------------------------------------------------------------------- |
|  `0` | Verdict passed, the review was skipped, or a failure was waived        |
|  `1` | Verdict failure. The tests need work                                   |
|  `2` | Environment or configuration error. **No review happened**             |
|  `3` | Agent or report-parse failure. **No review happened**                  |

`2` and `3` mean no review happened; the log says so, and so do the comment
and check run whenever the CLI got far enough to publish them (a failure in the
action before the CLI starts, such as the install, a missing credential or the
agent login, publishes neither). Neither is ever reported as approved tests. The CLI retries exit `3` once
(the action passes `--retries 1`; a fresh agent invocation, not a report
re-parse) before giving up: a crashed agent process is often a one-off blip
rather than a real problem with the diff. `1` and `2` are never retried; a
verdict or an environment error will not change on a second try. Put
`--retries <n>` in `extra-args` to change the count.

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

`report-path` and `json-path` upload as the `tea-test-review-<job>-<agent>`
artifact on every run, including a failed verdict. The comment carries only the
verdict and up to three gating findings, so the artifact is where the full
report lives; the comment names it.
Opt out with `upload-report: 'false'`.

## Configuration

Every input and default is documented in [`action.yml`](action.yml). The ones
with a consequence you would not guess:

- `base-ref` derives from the event, or through the pulls API on an
  `issue_comment` run (the CLI's `--pr`), so a pull request into a release
  branch diffs against that branch. A failed lookup fails the step; set
  `base-ref` to bypass it.
- `gate-on` selects whether only PR-introduced findings or all findings affect
  the verdict. Empty uses the CLI default: `introduced` for PR diffs and `all`
  when `--files` bypasses git evidence.
- `use-playwright-utils`, `use-pactjs-utils`, `pact-mcp`: state them in CI,
  where the packaged skill has no `_bmad/tea/config.yaml` beside it. Empty resolves
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
  extra-args: --waive "flaky suite, FP-1234" --waive-until 2030-01-01
```

That covers `--files`, `--test-glob`, `--timeout-ms`, `--fail-on-skip`,
`--waive`/`--waive-until`, `--isolate`/`--no-isolate`, `--env-pass` and
`--retries`. `--agent none` makes a dry run that builds the prompt and reviews
nothing (the `model` input is ignored for it); the CLI refuses to publish a review that never ran, so a dry run posts
no comment and no check run. See
the
[full CLI flag reference](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/blob/main/docs/reference/tea-test-review-cli.md).

## Outputs

| Output                              | Value                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `recommendation`                    | `Approve`, `Approve with Comments`, `Request Changes` or `Block`. Empty on a skip. |
| `quality-score`                     | Gating score out of 100. Empty on a skip.                                          |
| `full-quality-score`                | Effective score of the findings the report covers. Empty on a skip.                |
| `raw-quality-score`                 | Uncapped deduction score of the same findings. Empty on a skip.                    |
| `gate-on`                           | Effective gate mode: `introduced` or `all`. Empty on a skip.                       |
| `review-mode`                       | `pr` or `full-file`, how the review was scoped. Empty on a skip.                   |
| `critical`, `high`, `medium`, `low` | Gating violation counts.                                                           |
| `reviewed-files`                    | How many files the report says it reviewed.                                        |
| `skipped`                           | `true` when there were no changed test files.                                      |
| `report-path`, `json-path`          | Workspace-relative paths of the report and verdict.                                |

Every output keeps its name; the sources moved with the CLI's verdict.
`full-quality-score` and `raw-quality-score` read the verdict's `qualityScore`
and `rawQualityScore`. In `pr` review mode the verdict carries only the pull
request's own findings, and in `full-file` mode (`gate-on: all`, or `--files`)
every finding gates, so `full-quality-score` now equals `quality-score` and
`raw-quality-score` is the gating raw score; `review-mode` says which mode ran.
The verdict no longer scores pre-existing findings the pull request did not
touch. The verdict also dropped `allFindingsRecommendation`, the
recommendation over all findings; no output ever carried it, and neither does
the comment now.

## Other agents

`agent` defaults to `claude`. `codex` is built in: the CLI's adapter table
([`cli/lib/agent-adapters.js`](https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/blob/main/cli/lib/agent-adapters.js))
spawns it natively (`codex exec --sandbox workspace-write`), so the action
passes `agent` straight through as `--agent` and installs `@openai/codex` at
whatever `codex-version` resolves to, `latest` by default.

codex needs two things claude does not, and the action does both. codex never
reads `OPENAI_API_KEY` from the environment and authenticates only from
`~/.codex/auth.json`, which no runner has; handed only the variable, the run
dies on
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

- The review skill is the one packaged inside the globally installed CLI, out
  of the checkout, so a pull request that edits its own vendored `_bmad/` copy
  cannot rewrite the reviewer that judges it, and the skill and the CLI are
  always one version. The residual trust is whatever version installs: set
  `tea-version` to an exact release when you want to vet it once and bump it
  deliberately.
- `claude-code-version` and `codex-version` default to `latest`, so callers
  carry no bump; `tea-version` is described above. Each takes an exact version
  when a run has to be reproducible or a vendor release breaks it.
- The CLI upserts the comment on a hidden marker, so ten pushes update one
  comment, and two built-in agents on one pull request keep one comment each. The
  comment and the check run belong to the `github-token`'s account. A comment
  or check run that cannot be written is a warning and never changes the
  verdict. A failure before the CLI starts (npm install, a missing credential,
  agent login, a `tea-version` without `--github`) opens no check run and posts
  no comment; the job's own failure is the signal, and a required check stays
  Expected until a later run reports it.
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

The suite runs `main.js` as a child process against stand-ins for `npm` and
the CLI, with every declared input set, and asserts the CLI argv, environment
and outputs. The review itself is tested in the CLI's repository. What the
stand-ins cannot reach is covered by the `Test` workflow's `smoke` job, which
installs the real CLI, runs a dry run, then reviews this repository's own test
file and checks that exactly one comment results. It reports itself skipped
rather than red when no credential is present.
