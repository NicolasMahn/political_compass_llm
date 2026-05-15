#!/usr/bin/env python3
"""Build static UI data from persisted benchmark results.

Scans results/runs/<scenario>/<provider>/<model>/<config>/ and writes:
  ui/data/results_manifest.json

Notes:
  - `provider` is the model namespace before the slash (for example `mistralai`
    from `mistralai/mistral-small-2603`).
  - `router` is the API router used to call the model (currently `openrouter`).
  - Optional display overrides can be placed in ui/run_overrides.json.
  - OpenRouter model names are cached in ui/data/openrouter_models.json.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path
from typing import Any

RESULTS_ROOT = Path("results/runs")
OUT_PATH = Path("ui/data/results_manifest.json")
OVERRIDES_PATH = Path("ui/run_overrides.json")
OPENROUTER_MODELS_CACHE = Path("ui/data/openrouter_models.json")
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

DEFAULT_COLORS = [
    "#ef4444",
    "#2563eb",
    "#16a34a",
    "#f97316",
    "#7c3aed",
    "#0891b2",
    "#be123c",
    "#4d7c0f",
    "#9333ea",
    "#0f766e",
    "#ca8a04",
    "#475569",
]

def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def infer_model_provider(model: str | None) -> str:
    if not model:
        return "unknown"
    return model.split("/", 1)[0].lower() or "unknown"


def is_neutral(response: dict[str, Any]) -> bool:
    if response.get("answer_score") == 0 or response.get("answer_score") == 0.0:
        return True
    return str(response.get("answer", "")).strip().lower() in {"neutral", "neutral / unsure", "unsure"}


def run_path_parts(run_dir: Path) -> dict[str, str]:
    rel = run_dir.relative_to(RESULTS_ROOT)
    parts = rel.parts
    if len(parts) < 4:
        raise ValueError(f"Unexpected run path: {run_dir}")
    return {
        "scenario_id": parts[0],
        "path_provider": parts[1],
        "model_slug": parts[2],
        "config_slug": parts[3],
    }


def fetch_openrouter_models() -> dict[str, Any]:
    with urllib.request.urlopen(OPENROUTER_MODELS_URL, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    models = {item["id"]: item for item in payload.get("data", []) if "id" in item}
    write_json(OPENROUTER_MODELS_CACHE, models)
    return models


def load_openrouter_models(refresh: bool) -> dict[str, Any]:
    if refresh:
        try:
            return fetch_openrouter_models()
        except Exception as error:
            print(f"Warning: failed to refresh OpenRouter model cache: {error}")
    if OPENROUTER_MODELS_CACHE.exists():
        return read_json(OPENROUTER_MODELS_CACHE)
    try:
        return fetch_openrouter_models()
    except Exception as error:
        print(f"Warning: failed to fetch OpenRouter model labels: {error}")
        return {}


def load_overrides() -> dict[str, Any]:
    if not OVERRIDES_PATH.exists():
        return {}
    data = read_json(OVERRIDES_PATH)
    data.pop("README", None)
    return data


def override_for(run: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    keys = [
        run["id"],
        f"{run['scenario_id']}/{run['provider']}/{run['model_slug']}/{run['config_slug']}",
        f"{run['provider']}/{run['model_slug']}/{run['config_slug']}",
        run["model"],
        run["model_slug"],
    ]
    merged: dict[str, Any] = {}
    for key in keys:
        value = overrides.get(key)
        if isinstance(value, dict):
            merged.update(value)
    return merged


def shortest_unique_labels(runs: list[dict[str, Any]]) -> dict[str, str]:
    candidates: dict[str, list[str]] = {}
    for run in runs:
        model_label = run.get("openrouter_model_name") or run["model"] or run["model_slug"]
        scenario = run["scenario_id"]
        config = run["config_slug"]
        provider = run["provider"]
        router = run.get("router")
        candidates[run["id"]] = [
            str(model_label),
            f"{model_label} · {config}",
            f"{model_label} · {scenario} · {config}",
            f"{provider}/{model_label} · {scenario} · {config}",
            f"{router}/{provider}/{model_label} · {scenario} · {config}" if router else f"{provider}/{model_label} · {scenario} · {config}",
            run["id"],
        ]

    labels: dict[str, str] = {}
    for index in range(6):
        proposed = {run_id: options[min(index, len(options) - 1)] for run_id, options in candidates.items()}
        counts: dict[str, int] = {}
        for label in proposed.values():
            counts[label] = counts.get(label, 0) + 1
        for run_id, label in proposed.items():
            if run_id not in labels and counts[label] == 1:
                labels[run_id] = label
    for run_id, options in candidates.items():
        labels.setdefault(run_id, options[-1])
    return labels


def collect_runs(openrouter_models: dict[str, Any]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    if not RESULTS_ROOT.exists():
        return runs

    for final_path in sorted(RESULTS_ROOT.glob("*/*/*/*/final_result.json")):
        run_dir = final_path.parent
        metadata_path = run_dir / "metadata.json"
        responses_path = run_dir / "responses.json"
        if not metadata_path.exists() or not responses_path.exists():
            continue

        final_result = read_json(final_path)
        metadata = read_json(metadata_path)
        responses = read_json(responses_path)
        path_ids = run_path_parts(run_dir)

        model = final_result.get("model") or metadata.get("model")
        provider = final_result.get("provider") or metadata.get("provider") or infer_model_provider(model)
        router = final_result.get("router") or metadata.get("router")

        # Backward compatibility for early runs where provider incorrectly meant router.
        if provider == "openrouter":
            router = router or "openrouter"
            provider = infer_model_provider(model)

        response_count = len(responses)
        neutral_count = sum(1 for response in responses if is_neutral(response))
        neutral_rate = neutral_count / response_count if response_count else 0.0
        judge_confidences = [
            float(response["judge_confidence"])
            for response in responses
            if isinstance(response.get("judge_confidence"), int | float)
        ]
        openrouter_model = openrouter_models.get(model or "", {})

        run = {
            "scenario_id": path_ids["scenario_id"],
            "provider": provider,
            "router": router,
            "model_slug": final_result.get("model_slug") or metadata.get("model_slug") or path_ids["model_slug"],
            "config_slug": path_ids["config_slug"],
            "runtime_config_slug": final_result.get("config_slug") or metadata.get("config_slug") or path_ids["config_slug"],
            "run_id": final_result.get("run_id", path_ids["config_slug"]),
            "scenario_type": final_result.get("scenario_type") or metadata.get("scenario", {}).get("scenario_type"),
            "questionnaire_id": final_result.get("questionnaire_id") or metadata.get("questionnaire_id"),
            "model": model,
            "openrouter_model_name": openrouter_model.get("name"),
            "temperature": final_result.get("temperature"),
            "reasoning_effort": final_result.get("reasoning_effort"),
            "completed_at": final_result.get("completed_at"),
            "axis_scores": final_result.get("axis_scores", {}),
            "response_count": response_count,
            "neutral_count": neutral_count,
            "neutral_rate": neutral_rate,
            "judge_model": final_result.get("judge_model") or metadata.get("judge", {}).get("model"),
            "judge_reasoning_effort": final_result.get("judge_reasoning_effort") or metadata.get("judge", {}).get("reasoning_effort"),
            "response_type_counts": final_result.get("response_type_counts") or {},
            "average_judge_confidence": sum(judge_confidences) / len(judge_confidences) if judge_confidences else None,
            "answers": {
                "strongly_disagree": sum(1 for r in responses if r.get("answer_score") == -1.0),
                "disagree": sum(1 for r in responses if r.get("answer_score") == -0.5),
                "neutral": neutral_count,
                "agree": sum(1 for r in responses if r.get("answer_score") == 0.5),
                "strongly_agree": sum(1 for r in responses if r.get("answer_score") == 1.0),
            },
            "paths": {
                "run_dir": str(run_dir),
                "final_result": str(final_path),
                "responses": str(responses_path),
                "metadata": str(metadata_path),
            },
        }
        run["id"] = "/".join([run["scenario_id"], run["provider"], run["model_slug"], run["config_slug"]])
        runs.append(run)

    return runs


def apply_display_metadata(runs: list[dict[str, Any]], overrides: dict[str, Any]) -> None:
    unique_labels = shortest_unique_labels(runs)
    for index, run in enumerate(runs):
        override = override_for(run, overrides)
        run["default_label"] = unique_labels[run["id"]]
        run["label"] = override.get("label") or run["default_label"]
        run["color"] = override.get("color") or DEFAULT_COLORS[index % len(DEFAULT_COLORS)]


def build_tree(runs: list[dict[str, Any]]) -> dict[str, Any]:
    tree: dict[str, Any] = {}
    for run in runs:
        tree.setdefault(run["scenario_id"], {}).setdefault(run["provider"], {}).setdefault(run["model_slug"], {})[
            run["config_slug"]
        ] = run["id"]
    return tree


def main() -> None:
    parser = argparse.ArgumentParser(description="Build static UI manifest from result folders.")
    parser.add_argument("--refresh-openrouter-models", action="store_true", help="Refresh OpenRouter model label cache.")
    args = parser.parse_args()

    openrouter_models = load_openrouter_models(args.refresh_openrouter_models)
    overrides = load_overrides()
    runs = collect_runs(openrouter_models)
    apply_display_metadata(runs, overrides)

    manifest = {
        "schema_version": "1.0",
        "generated_from": str(RESULTS_ROOT),
        "run_count": len(runs),
        "tree": build_tree(runs),
        "runs": runs,
    }
    write_json(OUT_PATH, manifest)
    print(f"Wrote {len(runs)} runs to {OUT_PATH}")


if __name__ == "__main__":
    main()
