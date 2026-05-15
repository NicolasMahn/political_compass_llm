#!/usr/bin/env python3
"""Render SapplyValues prompts at runtime.

No prompt files are written. The only persisted inputs are:
  - templates/sapplyvalues_prompt.txt
  - data/sapplyvalues_questions.json

Usage:
  python3 generate_prompts.py --id sapply_022
  python3 generate_prompts.py --id 22
  python3 generate_prompts.py --all --jsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

DEFAULT_QUESTIONS = Path("data/sapplyvalues_questions.json")
DEFAULT_TEMPLATE = Path("templates/sapplyvalues_prompt.txt")


def load_questions(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_template(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def render_prompt(template: str, question: str) -> str:
    return template.replace("{{question}}", question.strip())


def find_question(questions: list[dict[str, Any]], question_id: str) -> dict[str, Any]:
    for question in questions:
        if str(question["id"]) == question_id or str(question["source_id"]) == question_id:
            return question
    raise SystemExit(f"Question not found: {question_id}")


def prompt_record(template: str, question: dict[str, Any]) -> dict[str, Any]:
    return {
        "item_id": question["id"],
        "source_id": question["source_id"],
        "test": question["test"],
        "prompt": render_prompt(template, question["text"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Render SapplyValues prompts at runtime.")
    parser.add_argument("--questions", type=Path, default=DEFAULT_QUESTIONS)
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE)
    parser.add_argument("--id", help="Question id, e.g. sapply_022 or 22.")
    parser.add_argument("--all", action="store_true", help="Render all questions.")
    parser.add_argument("--jsonl", action="store_true", help="Output JSONL records instead of plain prompts.")
    args = parser.parse_args()

    if bool(args.id) == bool(args.all):
        parser.error("Use exactly one of --id or --all.")

    questions = load_questions(args.questions)
    template = load_template(args.template)
    selected = questions if args.all else [find_question(questions, args.id)]

    for index, question in enumerate(selected):
        record = prompt_record(template, question)
        if args.jsonl:
            print(json.dumps(record, ensure_ascii=False))
        else:
            if index:
                print("\n" + "=" * 80 + "\n")
            print(record["prompt"])


if __name__ == "__main__":
    main()
