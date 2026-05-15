#!/usr/bin/env python3
"""Run a free-text SapplyValues scenario and judge implied answers.

Target model receives a realistic free-text prompt. A fixed judge model then maps
that response back onto the SapplyValues answer scale so existing scoring/UI can
be reused while preserving the raw target response and judge metadata.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from calculate_sapply_scores import calculate_scores, load_question_index, normalize_answer
from generate_prompts import load_questions, load_template, render_prompt
from run_sapply_test import (
    DEFAULT_MODEL,
    DEFAULT_TEMPERATURE,
    RESULT_SCHEMA_VERSION,
    call_openrouter,
    config_slug,
    extract_content,
    infer_model_provider,
    load_dotenv,
    now_iso,
    parse_json_object,
    read_existing_responses,
    response_key,
    slugify,
    write_json,
)

DEFAULT_SCENARIO = Path("scenarios/sapplyvalues/textual_casual_judged.json")
DEFAULT_JUDGE_MODEL = "openai/gpt-5.5"
DEFAULT_JUDGE_REASONING = "medium"

SCORE_TO_LABEL = {
    -1.0: "Strongly Disagree",
    -0.5: "Disagree",
    0.0: "Neutral / Unsure",
    0.5: "Agree",
    1.0: "Strongly Agree",
}


def load_scenario(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_target_messages(scenario: dict[str, Any], question: dict[str, Any]) -> list[dict[str, str]]:
    question_field = scenario.get("variables", {}).get("question_field", "text")
    question_text = str(question[question_field])
    messages = []
    for message_config in scenario["target_messages"]:
        template = load_template(Path(message_config["template_path"]))
        messages.append({"role": message_config["role"], "content": render_prompt(template, question_text)})
    return messages


def render_judge_template(template: str, *, question: str, target_response: str) -> str:
    return template.replace("{{question}}", question.strip()).replace("{{target_response}}", target_response.strip())


def build_judge_messages(scenario: dict[str, Any], question: dict[str, Any], target_response: str) -> list[dict[str, str]]:
    question_text = str(question["text"])
    messages = []
    for message_config in scenario["judge_messages"]:
        template = load_template(Path(message_config["template_path"]))
        messages.append(
            {
                "role": message_config["role"],
                "content": render_judge_template(template, question=question_text, target_response=target_response),
            }
        )
    return messages


def normalize_judgement(parsed: dict[str, Any]) -> dict[str, Any]:
    if "answer_score" in parsed:
        answer_score = normalize_answer(parsed["answer_score"])
    else:
        answer_score = normalize_answer(parsed.get("implied_answer"))
    answer = SCORE_TO_LABEL[answer_score]
    confidence = parsed.get("confidence", 0.0)
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    response_type = str(parsed.get("response_type", "unclear")).strip().lower()
    if response_type not in {"stance", "both_sides", "neutral", "refusal", "unclear", "informational"}:
        response_type = "unclear"
    return {
        "answer": answer,
        "answer_score": answer_score,
        "confidence": confidence,
        "evidence": str(parsed.get("evidence", "")).strip(),
        "response_type": response_type,
        "judge_reason": str(parsed.get("judge_reason", "")).strip(),
    }


def judge_response(
    *,
    api_key: str,
    scenario: dict[str, Any],
    question: dict[str, Any],
    target_response: str,
    judge_model: str,
    judge_temperature: float,
    judge_reasoning_effort: str | None,
    max_retries: int,
    parse_retries: int,
    timeout: int,
) -> tuple[dict[str, Any], str, list[str], dict[str, Any], list[dict[str, str]]]:
    messages = build_judge_messages(scenario, question, target_response)
    api_response: dict[str, Any] = {}
    raw_content = ""
    parsed: dict[str, Any] | None = None
    parse_errors: list[str] = []
    for parse_attempt in range(parse_retries + 1):
        api_response = call_openrouter(
            api_key=api_key,
            model=judge_model,
            messages=messages,
            temperature=judge_temperature,
            reasoning_effort=judge_reasoning_effort,
            max_retries=max_retries,
            timeout=timeout,
            json_response=True,
        )
        raw_content = extract_content(api_response)
        try:
            parsed = parse_json_object(raw_content)
            break
        except json.JSONDecodeError as error:
            parse_errors.append(f"attempt={parse_attempt + 1}, error={error}, raw_content={raw_content!r}")
            if parse_attempt < parse_retries:
                time.sleep(0.25 * (parse_attempt + 1))
    if parsed is None:
        raise ValueError("Judge did not return parseable JSON after retries: " + " | ".join(parse_errors))
    return normalize_judgement(parsed), raw_content, parse_errors, api_response, messages


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
    judge_model: str,
    judge_model_slug: str,
    judge_temperature: float,
    judge_reasoning_effort: str | None,
    max_retries: int,
    parse_retries: int,
    timeout: int,
) -> dict[str, Any]:
    target_messages = build_target_messages(scenario, question)
    started_at = now_iso()
    target_api_response = call_openrouter(
        api_key=api_key,
        model=model,
        messages=target_messages,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        max_retries=max_retries,
        timeout=timeout,
        json_response=False,
    )
    target_response = extract_content(target_api_response)

    judgement, judge_raw, judge_parse_errors, judge_api_response, judge_messages = judge_response(
        api_key=api_key,
        scenario=scenario,
        question=question,
        target_response=target_response,
        judge_model=judge_model,
        judge_temperature=judge_temperature,
        judge_reasoning_effort=judge_reasoning_effort,
        max_retries=max_retries,
        parse_retries=parse_retries,
        timeout=timeout,
    )

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
        "judge_model": judge_model,
        "judge_model_slug": judge_model_slug,
        "judge_temperature": judge_temperature,
        "judge_reasoning_effort": judge_reasoning_effort,
        "item_id": question["id"],
        "source_id": question["source_id"],
        "test": question["test"],
        "question": question["text"],
        "effects": question["effects"],
        "messages": target_messages,
        "target_response": target_response,
        "raw_response": judge_raw,
        "answer": judgement["answer"],
        "answer_score": judgement["answer_score"],
        "judge_confidence": judgement["confidence"],
        "judge_evidence": judgement["evidence"],
        "response_type": judgement["response_type"],
        "reason": judgement["judge_reason"],
        "judge_messages": judge_messages,
        "parse_errors": judge_parse_errors,
        "openrouter_response_id": target_api_response.get("id"),
        "judge_openrouter_response_id": judge_api_response.get("id"),
        "usage": target_api_response.get("usage"),
        "judge_usage": judge_api_response.get("usage"),
        "started_at": started_at,
        "completed_at": now_iso(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a free-text SapplyValues scenario and judge implied answers.")
    parser.add_argument("--questions", type=Path, default=Path("data/sapplyvalues_questions.json"))
    parser.add_argument("--scenario", type=Path, default=DEFAULT_SCENARIO)
    parser.add_argument("--model", default=os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL))
    parser.add_argument("--temperature", type=float, default=DEFAULT_TEMPERATURE)
    parser.add_argument("--reasoning-effort", "--reasoning", choices=["low", "medium", "high", "xhigh"])
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--judge-reasoning-effort", choices=["low", "medium", "high", "xhigh"], default=DEFAULT_JUDGE_REASONING)
    parser.add_argument("--judge-temperature", type=float, default=0.0)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--concurrency", type=int)
    parser.add_argument("--run-id")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--results-dir", type=Path, default=Path("results/runs"))
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--parse-retries", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=120)
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
    judge_model_slug = slugify(args.judge_model)
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
        "judge_model": args.judge_model,
        "judge_model_slug": judge_model_slug,
        "judge_temperature": args.judge_temperature,
        "judge_reasoning_effort": args.judge_reasoning_effort,
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
        pending_key = f"{scenario_id}:{item_id}:original:repeat-1"
        if pending_key in existing:
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
                        judge_model=args.judge_model,
                        judge_model_slug=judge_model_slug,
                        judge_temperature=args.judge_temperature,
                        judge_reasoning_effort=args.judge_reasoning_effort,
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
                        f"{record['answer']} ({record['answer_score']}), {record['response_type']}, "
                        f"conf={record['judge_confidence']:.2f}"
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
    response_type_counts: dict[str, int] = {}
    for response in responses:
        response_type = str(response.get("response_type", "unknown"))
        response_type_counts[response_type] = response_type_counts.get(response_type, 0) + 1
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
            "judge_model": args.judge_model,
            "judge_model_slug": judge_model_slug,
            "judge_temperature": args.judge_temperature,
            "judge_reasoning_effort": args.judge_reasoning_effort,
            "response_type_counts": response_type_counts,
            "concurrency": concurrency,
            "completed_at": now_iso(),
            "response_count": len(responses),
        }
    )
    write_json(run_dir / "final_result.json", final_result)

    print("\nFinal result:")
    print(json.dumps(final_result["axis_scores"], indent=2, ensure_ascii=False))
    print("Response types:")
    print(json.dumps(response_type_counts, indent=2, ensure_ascii=False))
    print(f"\nSaved to: {run_dir}")


if __name__ == "__main__":
    main()
