# Political Compass LLM Benchmark

A small benchmark for measuring how chat models answer political-value questionnaires under controlled prompting conditions.

The current baseline runs the SapplyValues questionnaire through OpenRouter, stores every model response, calculates axis scores, and builds a static browser UI for comparing results on a political compass.

## What this measures

This project measures a model's **answer profile under a specific test condition**. It should not be interpreted as a model's true political worldview.

Current baseline:

- Questionnaire: `data/sapplyvalues_questions.json`
- Scenario: `scenarios/sapplyvalues/simple_direct.json`
- Prompt template: `templates/sapplyvalues_prompt.txt`
- Temperature: `0.0`
- Router: OpenRouter
- Output: persisted JSON results in `results/runs/`
- Viewer: static UI in `ui/`

See `docs/test-caveats-and-iterations.md` for methodological caveats and future test variants.

## Main evaluations

The primary comparison set is the group shown by default in the UI. These models are run with all available reasoning-effort variants where supported, plus the no-reasoning/default run.

Main models:

- `anthropic/claude-opus-4.7`
- `anthropic/claude-sonnet-4.6`
- `google/gemini-3-flash-preview`
- `google/gemini-3.1-pro-preview`
- `openai/gpt-5.5`
- `x-ai/grok-4.3`
- `mistralai/mistral-small-2603`

Reasoning-effort variants:

- default / no reasoning
- `low`
- `medium`
- `high`
- `xhigh` where the model supports it

The static UI defaults to this main evaluation set so the compass, neutral-rate chart, and detail cards load with the primary comparison already selected.

## Setup

Requires Python 3 and an OpenRouter API key.

Create a `.env` file or export an environment variable:

```bash
OPENROUTER_API_KEY=...
```

`OPEN_ROUTER_KEY` is also accepted.

No package install is currently required; the scripts use the Python standard library.

## Running a benchmark

Smoke test one model on the first few questions:

```bash
python3 run_sapply_test.py --model mistralai/mistral-small-2603 --limit 3
```

Run a full default/no-reasoning evaluation:

```bash
python3 run_sapply_test.py --model anthropic/claude-opus-4.7
```

Run with a reasoning effort:

```bash
python3 run_sapply_test.py --model anthropic/claude-opus-4.7 --reasoning-effort high
```

If a run fails partway through, rerun with `--resume` to skip persisted answers:

```bash
python3 run_sapply_test.py --model anthropic/claude-opus-4.7 --reasoning-effort high --resume
```

Outputs are written to:

```text
results/runs/<scenario>/<provider>/<model_slug>/<config_slug>/
```

Each run directory contains:

- `metadata.json`
- `responses.jsonl`
- `responses.json`
- `final_result.json`

## Running the main evaluations

Example shell loop for the main model set:

```bash
models=(
  anthropic/claude-opus-4.7
  anthropic/claude-sonnet-4.6
  google/gemini-3-flash-preview
  google/gemini-3.1-pro-preview
  openai/gpt-5.5
  x-ai/grok-4.3
  mistralai/mistral-small-2603
)

efforts=(none low medium high xhigh)

for model in "${models[@]}"; do
  for effort in "${efforts[@]}"; do
    if [ "$effort" = none ]; then
      python3 run_sapply_test.py --model "$model" --resume
    else
      python3 run_sapply_test.py --model "$model" --reasoning-effort "$effort" --resume
    fi
  done
done
```

Some providers/models may reject certain reasoning-effort values. In that case, keep the successful supported variants and omit unsupported ones.

## Building UI data

After adding or changing results, rebuild the manifest consumed by the static UI:

```bash
python3 build_ui_data.py
```

This scans `results/runs/` and writes:

```text
ui/data/results_manifest.json
```

Optional labels/colors can be configured in:

```text
ui/run_overrides.json
```

Use `ui/run_overrides.example.json` as a reference.

## Viewing results

Serve the repo with any static file server, then open `ui/index.html`:

```bash
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000/ui/
```

The viewer includes:

- political compass chart
- progressive/conservative bar
- neutral/abstention rate by reasoning effort
- selected run detail cards
- hierarchical run selector by scenario, provider, model, and config

## Scoring

Scores are calculated by `calculate_sapply_scores.py` from normalized answer scores:

- Strongly Disagree: `-1.0`
- Disagree: `-0.5`
- Neutral / Unsure: `0.0`
- Agree: `0.5`
- Strongly Agree: `1.0`

The final result exposes axis scores including:

- `right`
- `auth`
- `prog`

Neutral answers are also counted separately and surfaced in the UI.
