# tea-test-review

`tea-test-review` runs the headless [TEA test-quality review](https://github.com/muratkeremozcan/bmad-method-test-architecture-enterprise)
against a pull request's changed test files, fails the step on the review
verdict, publishes the full report as one upserted PR comment, and uploads the
report as a run artifact. It carries no third-party JavaScript dependencies;
the only actions it uses are GitHub's own.

It packages what used to be a ~230-line workflow copied into every repository:
pin and unpack the review skill from an npm tarball, install the pinned CLI and
agent, run `tea-test-review`, then comment. One step replaces both jobs.

Always pin the action to a full commit SHA.

## Installation

```yaml
name: TEA Test Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions: {}

jobs:
  review:
    name: test review
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # Forks receive no secrets, so the review cannot run for them. Read the fork
    # caveat under "Important behavior" before making this a required check.
    if: github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      pull-requests: write # for the review comment
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the review diffs changed test files against the base ref
          persist-credentials: false

      - uses: muratkeremozcan/tea-test-review@<sha>
        with:
          min-score: '80'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Three things this workflow needs and will not work without:

- `fetch-depth: 0`. The review set comes from a git diff against the base ref,
  and a shallow checkout has no base ref to diff against.
- `pull-requests: write`, when `comment` is left on.
- A credential. Either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, as the
  step's `env:` above or as the `anthropic-api-key` / `claude-code-oauth-token`
  inputs. `ANTHROPIC_API_KEY` bills per token through the Anthropic Console.
  `CLAUDE_CODE_OAUTH_TOKEN` is a long-lived token minted from an existing Claude
  subscription with `claude setup-token`, with no separate API billing.

Node 22 or newer is installed on GitHub-hosted runners already, so no
`setup-node` step is required.

### `tea-version` has to be a version that ships the CLI

`bmad-method-test-architecture-enterprise@1.20.0` is the first release that does.
Every earlier version publishes the review *skill* and declares an empty `bin`,
and npm versions are immutable, so those will not gain it later.

The default is `latest`, so a fresh caller gets a release that ships the CLI
without pinning anything. The action still checks the unpacked tarball's
`package.json` before installing anything and fails with that explanation,
rather than letting the run die on `tea-test-review not found on PATH` two
installs later.

Pin an exact version when you want the verdict to be reproducible:

```yaml
with:
  tea-version: '1.20.0'
```

## Making it a required check

Require the job by name in the branch ruleset. The step's exit code is the
verdict: `0` passed, was skipped, or was waived; `1` is a verdict failure; `2`
and `3` mean the gate could not produce a verdict at all.

Read the fork caveat first. A repository that accepts pull requests from forks
cannot use this as its only protection.

## Artifacts

The action uploads `report-path` and `json-path` itself, as the
`tea-test-review-<job>` artifact on the workflow run, on every run including a
failed verdict. A report too large to inline in the PR comment is therefore
still recoverable after the runner is deleted; the comment says which artifact
holds it. Opt out with `upload-report: 'false'` and manage artifacts yourself.

## Configuration

Inputs and defaults are documented in [`action.yml`](action.yml). The ones worth
knowing about:

Gate policy, all optional and all off unless set: `min-score`, `max-critical`,
`min-files`, `fail-on`.

```yaml
with:
  min-score: '80'
  max-critical: '0'
  fail-on: block
```

Review scope: `base-ref` (derived from the event, so a pull request into a
release branch diffs against that branch), `test-dir`, `scope`.

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
  use-pactjs-utils: 'true'
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
[full CLI flag reference](https://github.com/muratkeremozcan/bmad-method-test-architecture-enterprise/blob/main/docs/reference/tea-test-review-cli.md).

## Outputs

| Output | Value |
| --- | --- |
| `recommendation` | `Approve`, `Approve with Comments`, `Request Changes` or `Block`. Empty on a skip. |
| `quality-score` | Score out of 100. Empty on a skip. |
| `critical`, `high`, `medium`, `low` | Violation counts. |
| `reviewed-files` | How many files the report says it reviewed. |
| `skipped` | `true` when there were no changed test files. |
| `report-path`, `json-path` | Workspace-relative paths of the report and verdict. |

## Other agents

`agent` defaults to `claude`. `codex` is also built in and proven by a live
run: the review CLI's own adapter table
([`cli/lib/agent-adapters.js`](https://github.com/muratkeremozcan/bmad-method-test-architecture-enterprise/blob/main/cli/lib/agent-adapters.js))
spawns it natively (`codex exec --sandbox workspace-write`), so this action
passes `agent` straight through as `--agent` and installs `@openai/codex`,
pinned by `codex-version`:

```yaml
with:
  agent: codex
  openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

codex needs one thing claude does not, and this action does it for you: codex
0.146.0 never reads `OPENAI_API_KEY` from the environment and authenticates
only from `~/.codex/auth.json`, which no runner has. Handed only the variable,
it sends no credential at all and the run dies on `401 ... Missing bearer or
basic authentication in header`. So before running the review, the action pipes
your key into `codex login --with-api-key` on stdin, never argv, so the
credential reaches disk without reaching the workflow log.

Any other value is a genuinely custom vendor and needs `agent-package`, and
usually `agent-command` and `agent-key-env`, so adding one needs no change
here:

```yaml
with:
  agent: gemini
  agent-package: '@google/gemini-cli@0.5.0'
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

- **Fork pull requests get no secrets, so the review cannot run for them.** This
  matters more than it looks: GitHub treats a skipped required check as passing,
  so a gate that skips on forks gives zero protection against external
  contributions. It is the contributions you trust least that go unreviewed.
  Guard the job with
  `if: github.event.pull_request.head.repo.full_name == github.repository` and
  pair the gate with something that does cover forks. Fork coverage needs a
  privileged design of its own, such as a `pull_request_target` workflow with
  strict controls.
- **Exit 2 and 3 are not verdicts.** Exit 1 means the tests need work. Exit 2 is
  an environment or configuration error and exit 3 is an agent or report-parse
  failure, and both mean no review happened. The action says so in the log and in
  the comment, and never reports either as approved tests.
- **A skip and a pass both exit 0.** A pull request that changes no test file
  skips the review. Read the `skipped` output to tell them apart, or pass
  `--fail-on-skip` through `extra-args` to make a skip fail instead.
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
- **`reviewed-files` counts the report's own manifest**, which is what
  `--min-files` evaluates, and is not the number of files in the diff.
- **A review takes minutes.** The CLI prints a heartbeat every 15 seconds and
  this action streams it straight through, so a live job shows progress rather
  than looking hung. Give the job a `timeout-minutes` that accommodates it.

## Development

```bash
node --test tests/*.test.js
```

The suite contains 148 tests and requires no dependency installation. The action
is composite: `main.js` runs on Node 24 (pinned with `actions/setup-node`,
which the `node24` runtime used to guarantee) and the report upload is
`actions/upload-artifact`, both GitHub's own.

Unit tests stub the `fetch` and child-process boundaries. What they cannot reach
is proven elsewhere: the `Test` workflow's `smoke` job unpacks the real tarball,
installs the pinned CLI, runs a live review against this repository's own test
file, and writes a real PR comment twice to prove the second run updates rather
than duplicates. That job detects a missing credential and reports that it was
skipped, so it does not go red on a repository that has not added one.
