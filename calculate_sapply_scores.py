#!/usr/bin/env python3
"""Calculate SapplyValues axis scores from structured LLM responses.

Question bank format:
  data/sapplyvalues_questions.json

Response input format:
  A JSON array of objects. Each response needs either `item_id` or `source_id`, plus
  either `answer_score` or `answer`.

Example response:
  {
    "item_id": "sapply_022",
    "answer": "Agree",
    "answer_score": 0.5,
    "model": "example-model"
  }

Scoring matches the upstream SapplyValues quiz:
  Strongly Agree    =  1.0
  Agree             =  0.5
  Neutral / Unsure  =  0.0
  Disagree          = -0.5
  Strongly Disagree = -1.0

Axis score:
  score[axis] = round((sum(answer_score * effect) * 10 / sum(abs(effect))) , 2)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ANSWER_TO_SCORE = {
    "strongly agree": 1.0,
    "agree": 0.5,
    "neutral / unsure": 0.0,
    "neutral": 0.0,
    "unsure": 0.0,
    "disagree": -0.5,
    "strongly disagree": -1.0,
    "stimme voll und ganz zu": 1.0,
    "stimme zu": 0.5,
    "neutral / unsicher": 0.0,
    "stimme nicht zu": -0.5,
    "stimme überhaupt nicht zu": -1.0,
    "强烈同意": 1.0,
    "同意": 0.5,
    "中立 / 不确定": 0.0,
    "中立": 0.0,
    "不确定": 0.0,
    "不同意": -0.5,
    "强烈不同意": -1.0,
}


def normalize_answer(value: Any) -> float:
    if isinstance(value, int | float):
        return float(value)
    if not isinstance(value, str):
        raise ValueError(f"Cannot parse answer score from {value!r}")
    key = value.strip().lower()
    if key not in ANSWER_TO_SCORE:
        raise ValueError(f"Unknown answer label: {value!r}")
    return ANSWER_TO_SCORE[key]


def load_question_index(path: Path) -> dict[str, dict[str, Any]]:
    questions = json.loads(path.read_text(encoding="utf-8"))
    index: dict[str, dict[str, Any]] = {}
    for question in questions:
        index[str(question["id"])] = question
        index[str(question["source_id"])] = question
    return index


def calculate_scores(question_index: dict[str, dict[str, Any]], responses: list[dict[str, Any]]) -> dict[str, Any]:
    max_scores: dict[str, float] = {}
    scores: dict[str, float] = {}
    used = 0
    missing: list[str] = []

    for response in responses:
        item_key = str(response.get("item_id", response.get("source_id", "")))
        question = question_index.get(item_key)
        if question is None:
            missing.append(item_key)
            continue

        if "answer_score" in response:
            answer_score = normalize_answer(response["answer_score"])
        else:
            answer_score = normalize_answer(response.get("answer"))

        for axis, effect in question["effects"].items():
            max_scores[axis] = max_scores.get(axis, 0.0) + abs(float(effect))
            scores[axis] = scores.get(axis, 0.0) + answer_score * float(effect)
        used += 1

    axis_scores = {
        axis: round((scores.get(axis, 0.0) * 10.0 / max_value), 2) if max_value else 0.0
        for axis, max_value in max_scores.items()
    }

    return {
        "axis_scores": axis_scores,
        "raw_scores": scores,
        "max_scores": max_scores,
        "responses_used": used,
        "missing_item_ids": missing,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Calculate SapplyValues scores from LLM responses.")
    parser.add_argument("--questions", type=Path, default=Path("data/sapplyvalues_questions.json"))
    parser.add_argument("--responses", type=Path, required=True)
    args = parser.parse_args()

    question_index = load_question_index(args.questions)
    responses = json.loads(args.responses.read_text(encoding="utf-8"))
    result = calculate_scores(question_index, responses)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
