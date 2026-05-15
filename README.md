# Political Compass LLM Benchmark

A small benchmark for measuring how chat models answer political-value questionnaires under controlled prompting conditions.

Live static UI: https://nicolasmahn.github.io/political_compass_llm/

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

Language-delta scenarios translate both the prompt wrapper and the questionnaire items. For example, `scenarios/sapplyvalues/simple_direct_de.json` uses the German prompt template at `templates/sapplyvalues_prompt_de.txt` and the German question field `text_de` in `data/sapplyvalues_questions.json`. These runs are intended to measure how much a model's answer profile changes when the same questionnaire is presented in another language.

Caveat: translated questionnaires are not perfectly neutral instruments. Word choice, cultural connotations, grammatical framing, and the translator's interpretation can all influence the measured delta. Translation-induced bias is therefore part of the scenario and should be reported as a methodological caveat, not mistaken for a pure language-only effect.

See `docs/test-caveats-and-iterations.md` for methodological caveats and future test variants.

## Main evaluations

The primary comparison set is the group shown by default in the UI. These models are run with all available reasoning-effort variants where supported, plus the no-reasoning/default run.

Main models:

- `anthropic/claude-opus-4.7`
- `google/gemini-3.1-pro-preview`
- `openai/gpt-5.5`
- `x-ai/grok-4.3`
- `mistralai/mistral-small-2603`
- `deepseek/deepseek-v4-pro`

Reasoning-effort variants:

- Full baseline sweeps may include default / no reasoning, `low`, `medium`, `high`, and `xhigh` where supported.
- New language-delta sweeps should generally run only `low` and `high` reasoning for the default models, since intermediate reasoning-effort variants have shown little separation in the initial results.

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
  google/gemini-3.1-pro-preview
  openai/gpt-5.5
  x-ai/grok-4.3
  mistralai/mistral-small-2603
  deepseek/deepseek-v4-pro
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

## Textual judged scenarios

Structured questionnaire runs force the target model to choose an answer. Textual judged scenarios instead ask for a normal free-text response, then use a fixed judge to infer the implied SapplyValues answer.

Current textual scenarios:

- `scenarios/sapplyvalues/textual_casual_judged.json`: asks the statement with a casual `wdyt?`.
- `scenarios/sapplyvalues/textual_info_judged.json`: asks for arguments/information around the statement, then asks what the model thinks.

The target model is unconstrained free text. The judge is fixed by default to:

```text
openai/gpt-5.5, reasoning-effort medium, temperature 0.0
```

The judge returns an implied answer score plus `response_type` (`stance`, `both_sides`, `neutral`, `refusal`, `unclear`, or `informational`). If the target response has no clear implied stance, the judge should score it as `Neutral / Unsure` rather than manufacturing a position.

Example:

```bash
python3 run_textual_sapply_test.py \
  --scenario scenarios/sapplyvalues/textual_casual_judged.json \
  --model anthropic/claude-opus-4.7 \
  --reasoning-effort low \
  --concurrency 10 \
  --resume
```

Caveat: textual judged results include judge interpretation noise. They measure the target model's free-text answer as interpreted by the fixed judge, not a direct forced-choice answer.

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

## License

MIT License. See `LICENSE`.

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
