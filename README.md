# agent-benchmark

Pi extension that runs a test suite against multiple provider/model combos. Two long-lived `herdr` panes (`benchmark-agent` and `benchmark-eval`) collaborate with the orchestrator to execute each test, capture the response, evaluate it, and record timing + token usage. Per-test results are written under `<suite>/results/` and `<suite>/eval/`, and a run summary is written to `<suite>/summary-<YYYYMMDD_HH:mm>.md`.

## Usage

```
/agent-benchmark <suite-folder> [retry_test]
```

- `retry_test` — optional, default `0`. When `1`, a first-attempt `FAIL` on a test gives the benchmark-agent one retry (see [Retries](#retries)). Accepts `0` or `1`.

## Suite folder layout

```
<suite>/
  models.yaml            # top-level `models:` list, one entry per line
  tests/                 # one YAML per test, iterated in sorted (filename) order
    001_trivial.yaml
    002_*.yaml
  results/               # bench-agent output — wiped at run start
  eval/                  # eval-agent output — wiped at run start
```

### `models.yaml`

```yaml
models:
  - ash/adversary_Qwopus3.6-35B-A3B-v1-APEX-I-Quality
  - ash/main_coder_Ornith-1.5-35B-A3B-APEX-I-Quality
  - minimax/MiniMax-M3
```

### Per-test YAML (`tests/<name>.yaml`)

```yaml
prompt: "What is 2+2? Answer with only the single digit."
evaluator_prompt: "The correct answer is '4' or 'four'"
```

- `prompt` and `evaluator_prompt` are required.
- The file's basename (without `.yaml`) becomes both the test's `id` and the output filename stem.

## Architecture

Three processes, all started via `herdr`:

```
user-agent (this extension, in pi)
  │ /agent-benchmark <suite>
  │ iterates models × tests
  │   for each (model, test):
  │     /new + settle on benchmark-agent
  │     /model <model> + settle
  │     send task prompt
  │     poll <suite>/results/<safeModel>-<base>.md + pane status
  │     if idle but file missing → one-shot reminder
  │     read response
  │     /new + settle on benchmark-eval
  │     send eval prompt (with response body)
  │     poll <suite>/eval/<safeModel>-<base>.md
  │     parse VERDICT/REASON
  │   at end: write summary-<timestamp>.md
  ▼
benchmark-agent (herdr pane at /home/ash/.pi/sub-agents/benchmark-agent/)
  writes: <suite>/results/<safeModel>-<base>.md

benchmark-eval (herdr pane at /home/ash/.pi/sub-agents/benchmark-eval/)
  writes: <suite>/eval/<safeModel>-<base>.md (VERDICT: PASS|FAIL, REASON: ...)
```

The two sub-agent panes are kept alive across runs. They are opened lazily on first use and reused for every subsequent test in the run.

## Per-test flow

For every `(model, test)` pair:

1. `/new` on benchmark-agent → wait for `idle`/`done` → settle 3s
2. `/model <model>` → wait for `idle`/`done` → settle 3s
3. Send the test's `prompt` with a directive to write the full response to `<suite>/results/<safeModel>-<base>.md`
4. Wait for the results file to exist; if benchmark-agent reaches `idle`/`done` but the file is missing, send **one** reminder. Give up after the reminder if the file still hasn't appeared. **No timeout** — the run blocks indefinitely on this file until either it appears or the reminder is ignored.
5. `durationMs` is read from the bench-agent's session JSONL: `max(timestamp across all entries) − timestamp of first role:user message` in the most-recent session file (which is the current test's, since `/new` creates a fresh file per test). This covers the full post-prompt activity — including any further assistant turns, tool calls, and post-write acknowledgements. The eval phase is excluded from `durationMs`.
6. Read the response and feed it into the eval prompt
7. `/new` on benchmark-eval → settle → send eval prompt → wait for `<suite>/eval/<safeModel>-<base>.md`
8. Parse `VERDICT: PASS|FAIL` and `REASON: ...` from the eval file

## Retries

When `retry_test=1`, a first-attempt `FAIL` on a test gives the benchmark-agent one retry. Any non-PASS first-attempt outcome (eval-verdict `FAIL`, missing results file, missing eval file, eval-pane setup failure) counts as `FAIL` for retry purposes.

The retry:

- **No** `/new` and **no** `/model` — continues the same session, so `durationMs` and tokens cover both attempts.
- Renames the attempt-0 outputs to `<file>_0.md` (e.g. `results/<safeModel>-<base>_0.md`, `eval/<safeModel>-<base>_0.md`) so the retry can reuse the bare filenames.
- Re-sends the bench prompt with `\nYou provided an incorrect answer! Please try again.` appended, then re-runs eval.
- The retry's verdict is **final** — no further retries. `FAIL` on retry is recorded as `FAIL` and the run continues to the next test.

The summary file's `## Failed tests` section surfaces both attempt-0 (`_0.md`) and final-attempt (`<file>.md`) contents when a retry happened, so the failure mode is fully auditable. `_progress.json` records the final verdict per `(model, test)`; the attempt-0 outputs are only preserved on disk.

## Output

### `results/<safeModel>-<base>.md`

Free-form markdown written by benchmark-agent in response to the test prompt.

### `eval/<safeModel>-<base>.md`

Markdown written by benchmark-eval. Expected format:

```
VERDICT: PASS|FAIL
REASON: <one sentence>
```

Anything before/after those lines is ignored.

Verdicts recorded in `_progress.json` and `summary-*.md` are one of `PASS` or `FAIL`. Any setup/transport failure (missing results file, missing eval file, eval-pane not settling) is recorded as `FAIL` with a descriptive `reason`.

### `_progress.json`

Updated continuously. Per-test entries with timing + tokens; per-model aggregates.

```json
{
  "completed": 6,
  "total": 9,
  "ran": 9,
  "passed": 6,
  "failed": 3,
  "results": [
    {
      "model": "ash/adversary_...",
      "test_id": "001_trivial",
      "duration_ms": 12345,
      "verdict": "PASS",
      "reason": "Correct answer",
      "tokens": { "total_tokens": 1547, "non_cached_tokens": 818 }
    }
  ],
  "model_totals": {
    "ash/adversary_...": {
      "duration_ms": 109082,
      "tests": 3, "passed": 2, "failed": 1,
      "tokens": { "total": 1558, "non_cached": 14833 }
    }
  }
}
```

- `results[].tokens.total_tokens` — cumulative context size at end of bench phase (from the session JSONL's `totalTokens`).
- `results[].tokens.non_cached_tokens` — fresh `input + output` for this test only (cache reads excluded).
- `model_totals[*].tokens.total` — last test's `total_tokens` (cumulative context at end of run for that model).
- `model_totals[*].tokens.non_cached` — sum across tests.
- `model_totals[*].tokens_per_second` — `non_cached / (duration_ms / 1000)`, the generation throughput for the model across the whole run. `0` if `duration_ms` is `0` (e.g. setup failure).

### `summary-<YYYYMMDD_HH:mm>.md`

One file per run, written to the suite root. Contains:

- Run timestamp, suite path, models list, test counts.
- A fenced block reproducing the TUI summary.
- A `## Failed tests` section listing every `(model, test)` with verdict FAIL, including the full contents of both the results file and the eval file. When a retry happened, both attempt-0 (`*_0.md`) and final-attempt contents are shown.

## Timing caveats — cold starts vs warm

`duration_ms` is sourced from the bench-agent session JSONL: the timestamp of the first `role:user` message (the task prompt) up to the **max** timestamp across all entries in that session. This window therefore covers everything the agent did from prompt-receipt onward — file writes, retries, post-write acknowledgements, anything else it generated — but excludes the `/new` + `/model` + 3s settle phases that precede the prompt.

Two implications worth knowing:

- **Max-timestamp, not last-line.** If the model emits a "task complete" assistant message *after* writing the file, that final timestamp is what ends the window. The bench-result-write tool call itself is the natural end of work; the trailing acknowledgement message is usually a fraction of a second later, but on verbose models the reported `duration_ms` will overshoot the actual work time.
- **Includes nudge round-trips.** If the bench agent stalls idle without writing the file and the orchestrator sends the one-shot reminder, the window also includes however long that reminder took to receive and act on. This is intentional: we want `duration_ms` to reflect the *full* wall-clock cost when things go wrong.

That means:

- **First test of a model run**: the model is already loaded into the API/server from the previous test in the same model loop — typical warm timing.
- **First test after a model switch**: the model may need to cold-start (especially for self-hosted / GGUF / llama.cpp endpoints). The `/model <model>` directive followed by a 3s settle is not always enough to hide this; cold-load latency of several seconds will show up in `duration_ms` for the first test of each model.
- **First test ever** (fresh process): both the pi runtime and the model itself may be cold. Treat the first test as a warmup; discard it if you're benchmarking for latency.

For reliable cross-model latency comparisons, either pre-warm each model with a throwaway test, or run each model multiple times and compare medians.

## Token caveats

Tokens are read from benchmark-agent's session JSONL after each test. Because `/new` creates a fresh session file per test, the most-recent JSONL in `<cwd>`'s session folder corresponds exactly to the current test — no snapshot diff is needed.

- `total_tokens` is cumulative within the session; it grows monotonically across the test's assistant turns.
- `non_cached_tokens` is the sum of fresh `input + output` across all assistant turns in that session. Cache reads (`cacheRead` tokens) are excluded — they're cheap or free depending on the provider.
- If the session file can't be read or has no assistant turn yet, tokens are omitted from the result (no error, just missing fields). A transient flush race is retried for up to ~600ms before giving up.

The eval-agent's session is **not** read — eval-phase token costs are not tracked, mirroring the rule that eval-phase time is also not tracked.

## TUI summary

At the end of a run:

```
agent-benchmark: done.
 Total: 9 | Ran: 9
 Passed: 6 | Failed: 3
 Per-model totals:
   ash/adversary_Qwopus3.6-35B-A3B-v1-APEX-I-Quality: 3 tests, 2 passed, 1 failed, 00:01:46.934 total, 1558 context, 14833 tokens, 134.1 tok/s
   ...
 Results: <suite>/results
 Evals: <suite>/eval
 Summary: <suite>/summary-<YYYYMMDD_HH:mm>.md
```

## Sub-agent setup

Two sub-agent folders must exist (paths are hardcoded in the extension):

- `/home/ash/.pi/sub-agents/benchmark-agent/` — test target. Has its own minimal `.pi/SYSTEM.md`. No project skills, no `AGENTS.md`. Clean isolation per test.
- `/home/ash/.pi/sub-agents/benchmark-eval/` — eval orchestrator. Has its own `.pi/SYSTEM.md` and the `herdr-agents` extension so it can spawn panes if needed.

These folders are created and maintained outside this extension. The benchmark-agent cwd contains no extensions (the prior `ensure-output-file` extension was removed when the orchestrator took over polling).

## Examples

`examples/tests-starter/` is a working suite:

```
examples/tests-starter/
  models.yaml
  tests/
    trivial-math_04.yaml
    needle.yaml
  results/      # created on first run
  eval/         # created on first run
```

Run with:

```
/agent-benchmark /home/ash/Work/.pi/extensions/agent-benchmark/examples/tests-starter
```

## Known limitations

- No timeouts. Hung benchmark-agent runs will block forever on the file-wait loop (after one reminder) — there's no automatic give-up. Use Ctrl-C to abort.
- `/new` + `/model` + 3s settle happens **before every test**, not just on model change. Adds ~6s of overhead per test in exchange for guaranteed fresh context.
- Model name sanitisation: `/` and other non-alphanumeric chars in model names become `_` in filenames.
- Session folder path is derived from `BENCH_PANE_CWD` constant. Changing the bench-agent's cwd requires updating the constant.
- **No soft cancel.** Once `/agent-benchmark` is running, the only way out is to exit Pi entirely with `Ctrl-D` (or `Ctrl-C`, which has the same effect — kills the parent pi process and the extension with it). There is no in-extension cancel signal, key binding, or inter-test abort path. Plan your runs accordingly; a stuck run blocks the orchestrating session until you exit.


## Dependencies
- **herdr** — must be on `$PATH`. Used to list/create/wait on agent panes and to read agent status.
- **Pi agent** with this extension loaded (`~/.pi/extensions/agent-benchmark/index.ts` or equivalent).
- **Two sub-agent folders** (see Sub-agent setup above). (https://github.com/ashLatham/pi-herdr-agents)
- **Node `fs`/`path`/`child_process`** — standard library, no `npm install` needed.



## Links

- GitHub: https://github.com/ashLatham/pi-herdr-agent-benchmark
- Pi Agent: https://github.com/earendil-works/pi
- Herdr: https://github.com/herdrdev/herdr 

## License
MIT
