#!/usr/bin/env python3
"""Run a SapplyValues questionnaire scenario against an OpenRouter chat model.

The current default scenario is the simple/direct baseline: each item is asked
once in a fresh prompt. Scenario config is explicit so later paraphrase,
translation, user-simulation, or multi-message variants can be added without
changing the result schema.

Persists:
  results/runs/<scenario_id>/<provider>/<model_slug>/<config_slug>/metadata.json
  results/runs/<scenario_id>/<provider>/<model_slug>/<config_slug>/responses.jsonl
  results/runs/<scenario_id>/<provider>/<model_slug>/<config_slug>/responses.json
  results/runs/<scenario_id>/<provider>/<model_slug>/<config_slug>/final_result.json

`provider` means the model namespace before the slash (for example `mistralai`
from `mistralai/mistral-small-2603`), while `router` means the API router used
to call it (currently openrouter).

Usage:
  python3 run_sapply_test.py
  python3 run_sapply_test.py --scenario scenarios/sapplyvalues/simple_direct.json
  python3 run_sapply_test.py --model mistralai/mistral-small-3.2-24b-instruct
  python3 run_sapply_test.py --limit 3
  python3 run_sapply_test.py --concurrency 46
  python3 run_sapply_test.py --concurrency 10 --run-id batched-run
  python3 run_sapply_test.py --reasoning-effort xhigh --model openai/gpt-5.5
  python3 run_sapply_test.py --run-id test-run --resume
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from calculate_sapply_scores import calculate_scores, load_question_index, normalize_answer
from generate_prompts import load_questions, load_template, render_prompt

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "mistralai/mistral-small-3.2-24b-instruct"
DEFAULT_TEMPERATURE = 0.0
DEFAULT_SCENARIO = Path("scenarios/sapplyvalues/simple_direct.json")
RESULT_SCHEMA_VERSION = "1.0"

ANSWER_LABELS = {
    "strongly disagree": "Strongly Disagree",
    "disagree": "Disagree",
    "neutral / unsure": "Neutral / Unsure",
    "neutral": "Neutral / Unsure",
    "unsure": "Neutral / Unsure",
    "agree": "Agree",
    "strongly agree": "Strongly Agree",
}


def load_dotenv(path: Path = Path(".env")) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"(^-|-$)", "", value)
    return value or "model"


def config_slug(*, temperature: float, reasoning_effort: str | None) -> str:
    temperature_slug = f"temp-{temperature:g}".replace(".", "p")
    reasoning_slug = f"reasoning-{reasoning_effort or 'none'}"
    return f"{temperature_slug}__{reasoning_slug}"


def infer_model_provider(model: str) -> str:
    return model.split("/", 1)[0].lower() or "unknown"


def parse_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def normalize_response(parsed: dict[str, Any]) -> dict[str, Any]:
    answer_raw = str(parsed.get("answer", "")).strip()
    answer_key = answer_raw.lower()
    answer = ANSWER_LABELS.get(answer_key, answer_raw)

    if "answer_score" in parsed:
        answer_score = normalize_answer(parsed["answer_score"])
    else:
        answer_score = normalize_answer(answer)

    # Keep label consistent with score if model emitted a weird label but valid score.
    score_to_label = {
        -1.0: "Strongly Disagree",
        -0.5: "Disagree",
        0.0: "Neutral / Unsure",
        0.5: "Agree",
        1.0: "Strongly Agree",
    }
    if answer_score in score_to_label:
        answer = score_to_label[answer_score]

    return {
        "answer": answer,
        "answer_score": answer_score,
        "reason": str(parsed.get("reason", "")).strip(),
    }


def call_openrouter(
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float,
    reasoning_effort: str | None,
    max_retries: int,
    timeout: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "temperature": temperature,
        "messages": messages,
        "response_format": {"type": "json_object"},
    }
    if reasoning_effort:
        payload["reasoning"] = {"effort": reasoning_effort}

    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost/political-compass-llm",
        "X-Title": "Political Compass LLM Benchmark",
    }

    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        request = urllib.request.Request(OPENROUTER_URL, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            last_error = RuntimeError(f"OpenRouter HTTP {error.code}: {body}")
            if error.code not in {429, 500, 502, 503, 504}:
                raise last_error
        except Exception as error:  # network/timeouts/transient JSON etc.
            last_error = error

        if attempt < max_retries:
            time.sleep(2**attempt)

    assert last_error is not None
    raise last_error


def extract_content(openrouter_response: dict[str, Any]) -> str:
    return str(openrouter_response["choices"][0]["message"]["content"])


def response_key(record: dict[str, Any]) -> str:
    scenario_id = record.get("scenario_id", "unknown_scenario")
    item_id = record.get("item_id", "unknown_item")
    variant_id = record.get("variant_id", "original")
    repeat = record.get("repeat", 1)
    return f"{scenario_id}:{item_id}:{variant_id}:repeat-{repeat}"


def read_existing_responses(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    responses: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        responses[response_key(record)] = record
    return responses


def load_scenario(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_messages(scenario: dict[str, Any], question: dict[str, Any]) -> list[dict[str, str]]:
    question_field = scenario.get("variables", {}).get("question_field", "text")
    question_text = str(question[question_field])
    messages = []
    for message_config in scenario["messages"]:
        template = load_template(Path(message_config["template_path"]))
        messages.append(
            {
                "role": message_config["role"],
                "content": render_prompt(template, question_text),
            }
        )
    return messages


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run_question(
    *,
    run_id: str,
    scenario: dict[str, Any],
    scenario_id: str,
    model: str,
    model_slug: str,
    provider: str,
    router: str,
    config_id: str,
    api_key: str,
    question: dict[str, Any],
    temperature: float,
    reasoning_effort: str | None,
    max_retries: int,
    parse_retries: int,
    timeout: int,
) -> dict[str, Any]:
    messages = build_messages(scenario, question)
    started_at = now_iso()
    api_response: dict[str, Any] = {}
    raw_content = ""
    parsed: dict[str, Any] | None = None
    parse_errors: list[str] = []

    for parse_attempt in range(parse_retries + 1):
        api_response = call_openrouter(
            api_key=api_key,
            model=model,
            messages=messages,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            max_retries=max_retries,
            timeout=timeout,
        )
        raw_content = extract_content(api_response)
        try:
            parsed = parse_json_object(raw_content)
            break
        except json.JSONDecodeError as error:
            finish_reason = api_response.get("choices", [{}])[0].get("finish_reason")
            parse_errors.append(
                f"attempt={parse_attempt + 1}, finish_reason={finish_reason}, "
                f"error={error}, raw_content={raw_content!r}"
            )
            if parse_attempt < parse_retries:
                time.sleep(0.25 * (parse_attempt + 1))

    if parsed is None:
        raise ValueError("Model did not return parseable JSON after retries: " + " | ".join(parse_errors))

    normalized = normalize_response(parsed)

    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "run_id": run_id,
        "scenario_id": scenario_id,
        "scenario_type": scenario.get("scenario_type"),
        "prompt_builder": scenario.get("prompt_builder"),
        "variant_id": "original",
        "repeat": 1,
        "model": model,
        "model_slug": model_slug,
        "provider": provider,
        "router": router,
        "config_slug": config_id,
        "reasoning_effort": reasoning_effort,
        "item_id": question["id"],
        "source_id": question["source_id"],
        "test": question["test"],
        "question": question["text"],
        "effects": question["effects"],
        "messages": messages,
        "answer": normalized["answer"],
        "answer_score": normalized["answer_score"],
        "reason": normalized["reason"],
        "raw_response": raw_content,
        "parse_errors": parse_errors,
        "openrouter_response_id": api_response.get("id"),
        "usage": api_response.get("usage"),
        "started_at": started_at,
        "completed_at": now_iso(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a SapplyValues scenario against an OpenRouter model.")
    parser.add_argument("--questions", type=Path, default=Path("data/sapplyvalues_questions.json"))
    parser.add_argument("--scenario", type=Path, default=DEFAULT_SCENARIO)
    parser.add_argument("--model", default=os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL))
    parser.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    parser.add_argument(
        "--reasoning-effort",
        "--reasoning",
        choices=["low", "medium", "high", "xhigh"],
        help="OpenRouter reasoning effort. Omitted by default because not all models support it.",
    )
    parser.add_argument("--limit", type=int, help="Only run the first N questions, useful for smoke tests.")
    parser.add_argument(
        "--concurrency",
        type=int,
        help="Number of questions to request in parallel. Defaults to all selected questions.",
    )
    parser.add_argument("--run-id", help="Explicit leaf output directory name. Defaults to config slug.")
    parser.add_argument("--resume", action="store_true", help="Skip already persisted item_ids in this run.")
    parser.add_argument("--results-dir", type=Path, default=Path("results/runs"))
    parser.add_argument("--max-retries", type=int, default=3, help="HTTP/network retries per request.")
    parser.add_argument("--parse-retries", type=int, default=2, help="Retries when a model returns empty or non-JSON content.")
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()

    load_dotenv()
    api_key = os.environ.get("OPEN_ROUTER_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("Missing OPEN_ROUTER_KEY or OPENROUTER_API_KEY in environment/.env")

    questions = load_questions(args.questions)
    if args.limit is not None:
        questions = questions[: args.limit]
    scenario = load_scenario(args.scenario)
    scenario_id = scenario["scenario_id"]
    concurrency = args.concurrency or len(questions)
    if concurrency < 1:
        raise SystemExit("--concurrency must be >= 1")

    router = "openrouter"
    provider = infer_model_provider(args.model)
    model_slug = slugify(args.model)
    config_id = config_slug(temperature=args.temperature, reasoning_effort=args.reasoning_effort)
    run_id = args.run_id or config_id
    run_dir = args.results_dir / scenario_id / provider / model_slug / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    metadata = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "run_id": run_id,
        "started_at": now_iso(),
        "model": args.model,
        "model_slug": model_slug,
        "provider": provider,
        "router": router,
        "config_slug": config_id,
        "temperature": args.temperature,
        "reasoning_effort": args.reasoning_effort,
        "questions_path": str(args.questions),
        "questionnaire_id": scenario.get("questionnaire_id"),
        "question_count": len(questions),
        "concurrency": concurrency,
        "parse_retries": args.parse_retries,
        "scenario_path": str(args.scenario),
        "scenario": scenario,
    }
    write_json(run_dir / "metadata.json", metadata)

    responses_jsonl = run_dir / "responses.jsonl"
    existing = read_existing_responses(responses_jsonl) if args.resume else {}

    pending_questions: list[tuple[int, dict[str, Any]]] = []
    for index, question in enumerate(questions, start=1):
        item_id = str(question["id"])
        pending_record_key = f"{scenario_id}:{item_id}:original:repeat-1"
        if pending_record_key in existing:
            print(f"[{index}/{len(questions)}] skip {item_id} (resume)")
            continue
        pending_questions.append((index, question))

    if pending_questions:
        print(f"Requesting {len(pending_questions)} questions in batches of {concurrency}")

    def batches(items: list[tuple[int, dict[str, Any]]], size: int) -> list[list[tuple[int, dict[str, Any]]]]:
        return [items[start : start + size] for start in range(0, len(items), size)]

    with responses_jsonl.open("a", encoding="utf-8") as response_file:
        for batch_number, batch in enumerate(batches(pending_questions, concurrency), start=1):
            print(f"Batch {batch_number}: requesting {len(batch)} questions")
            batch_errors: list[str] = []
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = {
                    executor.submit(
                        run_question,
                        run_id=run_id,
                        scenario=scenario,
                        scenario_id=scenario_id,
                        model=args.model,
                        model_slug=model_slug,
                        provider=provider,
                        router=router,
                        config_id=config_id,
                        api_key=api_key,
                        question=question,
                        temperature=args.temperature,
                        reasoning_effort=args.reasoning_effort,
                        max_retries=args.max_retries,
                        parse_retries=args.parse_retries,
                        timeout=args.timeout,
                    ): (index, question)
                    for index, question in batch
                }

                for future in as_completed(futures):
                    index, question = futures[future]
                    item_id = str(question["id"])
                    try:
                        record = future.result()
                    except Exception as error:
                        message = f"[{index}/{len(questions)}] ERROR {scenario_id}/{item_id}: {error}"
                        print(message)
                        batch_errors.append(message)
                        continue

                    response_file.write(json.dumps(record, ensure_ascii=False) + "\n")
                    response_file.flush()
                    print(
                        f"[{index}/{len(questions)}] done {scenario_id}/{item_id}: "
                        f"{record['answer']} ({record['answer_score']})"
                    )

            if batch_errors:
                raise RuntimeError(
                    "Batch completed with failed questions. Successful answers were persisted; "
                    "rerun with --resume to retry failed items.\n" + "\n".join(batch_errors)
                )

    responses = list(read_existing_responses(responses_jsonl).values())
    responses.sort(key=lambda record: int(record["source_id"]))
    write_json(run_dir / "responses.json", responses)

    question_index = load_question_index(args.questions)
    final_result = calculate_scores(question_index, responses)
    final_result.update(
        {
            "schema_version": RESULT_SCHEMA_VERSION,
            "run_id": run_id,
            "scenario_id": scenario_id,
            "scenario_type": scenario.get("scenario_type"),
            "prompt_builder": scenario.get("prompt_builder"),
            "questionnaire_id": scenario.get("questionnaire_id"),
            "model": args.model,
            "model_slug": model_slug,
            "provider": provider,
            "router": router,
            "config_slug": config_id,
            "temperature": args.temperature,
            "reasoning_effort": args.reasoning_effort,
            "concurrency": concurrency,
            "completed_at": now_iso(),
            "response_count": len(responses),
        }
    )
    write_json(run_dir / "final_result.json", final_result)

    print("\nFinal result:")
    print(json.dumps(final_result["axis_scores"], indent=2, ensure_ascii=False))
    print(f"\nSaved to: {run_dir}")


if __name__ == "__main__":
    main()
