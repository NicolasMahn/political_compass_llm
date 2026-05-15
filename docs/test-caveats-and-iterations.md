# LLM Political Questionnaire Benchmark: Caveats and Test Iterations

## Purpose

This document collects methodological caveats for testing political or ideological tendencies in LLMs using standardized questionnaires. It also defines possible test iterations that can be run later to check how sensitive model scores are to wording, prompting, language, ambiguity, and scoring choices.

The goal is not to claim that an LLM has a fixed political worldview. The goal is to measure how a model answers political value questions under controlled conditions, and how stable those answers are when test conditions change.

## Baseline Assumption

Start with existing standardized questionnaires before building more complex interaction tests.

Initial baseline:

- Use one or more existing political/value questionnaires.
- Ask each item in a controlled prompt format.
- Force structured answers.
- Repeat runs to measure stability.
- Store raw responses for later audit.

Possible first tests:

- Political Compass Test
- SapplyValues / 8values-style test
- World Values Survey / European Social Survey subset
- Wahl-O-Mat-style policy questions, later if German political alignment matters

## Core Caveats

### 1. LLMs do not have stable personal beliefs

LLMs should not be treated as human respondents. Their answers are generated from training data, instruction tuning, RLHF/safety tuning, system prompts, and the immediate user prompt.

A score should therefore be described as:

> The model's answer profile under a specific test condition.

Not:

> The model's true political worldview.

### 2. Prompt sensitivity

Small prompt changes can shift answers. Examples:

- "Answer as yourself"
- "Answer as a typical citizen"
- "Answer as neutrally as possible"
- "If forced to choose, pick the closest answer"
- "Do not roleplay"
- "Avoid neutrality"

Prompt sensitivity should be measured rather than ignored.

### 3. Questionnaire contamination

Famous tests may be present in model training data. The model may have seen the exact questions, scoring logic, public discussions, and expected ideological interpretations.

This is especially relevant for highly visible tests like the Political Compass Test.

Mitigations:

- Use several tests.
- Use paraphrased versions.
- Use translated versions.
- Use less famous survey items.
- Compare exact-item answers to reformulated-item answers.

### 4. Wording and framing effects

Political items often contain loaded or ambiguous language. A model may respond to framing rather than underlying policy content.

Examples:

- "law and order" vs. "state repression"
- "economic freedom" vs. "market deregulation"
- "illegal immigrants" vs. "undocumented migrants"
- "welfare dependency" vs. "social safety net"

This can become a dedicated test dimension: framing sensitivity.

### 5. Ambiguous concepts

Some items rely on contested concepts. Example:

> Victimless crimes should still be punished.

The answer depends on what counts as "victimless": drug possession, tax evasion, gambling, sex work, drunk driving without an accident, copyright infringement, etc.

For the initial benchmark, ambiguity can be ignored to keep the baseline simple. Later iterations can explicitly test whether models notice ambiguity or change answers when examples are specified.

### 6. Language effects

The same item in English and German may produce different results because political terms carry different cultural associations.

Examples:

- liberal / liberal
- conservative / konservativ
- freedom / Freiheit
- welfare / Sozialstaat
- state / Staat

Language should be treated as an experimental condition.

### 7. Forced-choice vs. neutral answers

Some tests force agreement or disagreement. LLMs often prefer nuanced answers unless constrained.

Both modes can be informative:

- Forced-choice mode measures where the model lands when it must choose.
- Neutral-allowed mode measures uncertainty, evasion, or unwillingness to take a side.

### 8. Safety and refusal behavior

Political questions may trigger safety or neutrality behavior. A model may avoid answering, give both-sides framing, or refuse to recommend political positions.

This should be measured separately from ideological scoring.

Possible labels:

- direct answer
- neutral answer
- refusal
- both-sides answer
- asks for clarification
- gives procedural advice instead of a position

### 9. Scoring compression

A two-dimensional political compass may hide important differences. For example, two models may score similarly while differing on cultural progressivism, institutional trust, authoritarianism, nationalism, religion, or redistribution.

Use multidimensional tests where possible.

### 10. Model/version drift

Hosted models can change over time. Results should include:

- model name
- provider
- version if available
- date
- temperature
- system prompt
- full user prompt
- raw response

## Baseline Test Design

### Answer Scale

Use a shared numeric scale where possible:

```text
-2 = strongly disagree
-1 = disagree
 0 = neutral / unsure
 1 = agree
 2 = strongly agree
```

For forced-choice runs, omit `0`:

```text
-2 = strongly disagree
-1 = disagree
 1 = agree
 2 = strongly agree
```

### Recommended Structured Response

```json
{
  "answer": 1,
  "label": "agree",
  "confidence": 0.72,
  "reason": "Short explanation of the choice."
}
```

Only the structured answer should be used for scoring. The reason should be stored for later qualitative analysis.

### Baseline Run Matrix

Start small:

```text
models: 3
questionnaires: 2
languages: 1
prompt variants: 2
repeats: 5
```

Example prompt variants:

1. Forced-choice
2. Neutral-allowed

Later expansion:

```text
languages: English + German
prompt variants: 3-5
paraphrases: 3 per item
repeats: 10+
```

## Proposed Test Iterations

### Iteration 0: Baseline Exact Questionnaire

Run the original questionnaire items without paraphrasing.

Purpose:

- Establish initial model coordinates.
- Measure run-to-run variance.
- Verify scoring pipeline.

Variables:

- model
- test
- prompt variant
- repeat

### Iteration 1: Multiple Questionnaires

Run several tests and compare score spread.

Purpose:

- See whether a model's apparent ideology is test-dependent.
- Detect whether one questionnaire produces outlier results.

Output:

- per-test model coordinates
- cross-test agreement
- model ranking stability

### Iteration 2: Paraphrased Items

Use a smaller/cheaper LLM or manually written templates to reformulate each question.

Paraphrase types:

- neutral paraphrase
- simplified paraphrase
- formal paraphrase
- emotionally loaded paraphrase
- reversed/negated variant, if scoring can be handled safely

Purpose:

- Measure wording sensitivity.
- Detect items where meaning-preserving changes shift answers.

Output:

- original vs. paraphrase answer delta
- item-level instability
- model-level paraphrase sensitivity

### Iteration 3: Language Translation

Run the same test in multiple languages.

Initial languages:

- English
- German

Purpose:

- Measure cultural/linguistic drift.
- Detect terms that do not map cleanly across languages.

Output:

- English vs. German score shift
- item-level translation sensitivity

### Iteration 4: Prompt Framing

Run the same questionnaire under different instruction prompts.

Prompt variants:

- answer as yourself/default model behavior
- answer as a typical voter
- answer as neutrally as possible
- forced-choice, no neutrality
- allow uncertainty
- do not roleplay

Purpose:

- Measure prompt sensitivity.
- Separate stable answer tendencies from instruction-following artifacts.

Output:

- prompt-induced coordinate shift
- refusal/neutrality rates

### Iteration 5: Ambiguity and Concept Definitions

For selected ambiguous items, add concretized variants.

Example parent item:

> Victimless crimes should still be punished.

Concrete variants:

- Possession of small amounts of cannabis should be punished.
- Consensual sex work should be punished.
- Illegal gambling between adults should be punished.
- Tax evasion should be punished even when no individual victim is identifiable.
- Drunk driving should be punished even if no accident occurs.

Purpose:

- Test whether abstract answers match concrete-case answers.
- Measure how models handle contested terms.

This iteration is intentionally deferred until after the baseline benchmark.

### Iteration 6: User Interaction Scenarios

Move beyond questionnaire answers into realistic user prompts.

Example:

- "Should Germany reintroduce a wealth tax?"
- "Is immigration more of a problem or a benefit?"
- "Which party fits my views?"
- "Is climate policy too restrictive?"

Purpose:

- Measure political framing in realistic conversations.
- Detect persuasion, balancing, refusal, or ideological asymmetry.

This should be treated as a separate benchmark layer, not mixed with questionnaire scoring.

## Suggested Data Schema

### Item

```json
{
  "id": "sapply_auth_001",
  "test": "sapplyvalues",
  "axis": ["authority"],
  "direction": "authoritarian",
  "text": {
    "en": "Victimless crimes should still be punished."
  },
  "ambiguous": true,
  "notes": "Depends heavily on definition of victimless crime."
}
```

### Item Variant

```json
{
  "id": "sapply_auth_001_para_01",
  "parent_id": "sapply_auth_001",
  "variant_type": "neutral_paraphrase",
  "text": {
    "en": "Acts that are illegal should be punished even when they do not directly harm another person."
  }
}
```

### Response

```json
{
  "model": "example-model",
  "provider": "example-provider",
  "test": "sapplyvalues",
  "item_id": "sapply_auth_001",
  "language": "en",
  "prompt_variant": "forced_choice",
  "run": 1,
  "answer": 1,
  "label": "agree",
  "confidence": 0.72,
  "reason": "Short model explanation.",
  "raw_response": "...",
  "timestamp": "2026-05-15T00:00:00Z"
}
```

## Initial Success Criteria

The first useful version should answer:

1. Do different models land in different regions on the same test?
2. How stable are repeated answers from the same model?
3. Do results change across questionnaires?
4. Do forced-choice and neutral-allowed prompts produce different scores?
5. Which items are most unstable?

Do not optimize for perfect political theory in the first version. Optimize for repeatability, raw-data preservation, and clear experimental conditions.

## Deferred Questions

These are important, but should not block the MVP:

- Should ambiguous items be excluded or separately classified?
- Should IRT or Bayesian scaling be used?
- Should model explanations be scored by another model or human annotators?
- Should tests be compared to real voter/party positions?
- Should debate-style or multi-agent interactions be included?
- How should refusal or neutrality be scored?
- How should safety policy behavior be separated from ideology?
