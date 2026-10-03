# Recruiting agent

Turns a job description into criteria, suggests a budget, scores scout submissions and summarizes the pipeline. Anything that decides money or a ranking is computed in code: the bounty and candidate count in `budget.ts` (a heuristic on seniority and rarity), and the score and recommendation in `scoring.ts` (from weighted verdicts). The models only extract criteria, judge evidence per criterion and write explanations. A human makes every final decision, which is the human-in-the-loop framing for the EU AI Act.

## API (`import { … } from "./agent/index.ts"`)

| Export | Returns |
|---|---|
| `draftRole(jobDescription)` | `{ title, summary, criteria }`. Criteria ids are kebab-case slugs, unique across all lists; weights are 1-5. |
| `suggestBudget(criteria, { title? })` | `{ bounty: bigint /* USDC base units */, maxCandidates, rationale }` |
| `reviewSubmission(criteria, { name, profileUrl, notes })` | `AgentReview`, with exactly one verdict per criterion, in criteria order. |
| `reviewSubmissionDetailed(criteria, candidate, engine?)` | `{ review, engine, latencyMs, costUsd, probabilities?, summarySource }` for logs and debugging. |
| `pipelineSummary({ title, bounty, deposited, paid, remaining, maxCandidates, acceptedCount, pendingCount, rejectedCount, recentReviews })` | 2-3 sentences. |
| `publishTask({ status, vaultBalance, bounty, maxCandidates, acceptedCount, pendingCount })` | `{ publish, reason }`. Pure function, no model call. |
| `providerLabel()`, `defaultReviewEngine()` | For display and logs. |

### Verdict semantics

A verdict says whether the criterion's statement holds for the candidate. For must-haves and nice-to-haves, MET is good. Deal breakers are phrased as the disqualifying condition (for example "Needs visa sponsorship"), so MET means the candidate triggers it, and the UI should show it in red.

### Scoring (`scoring.ts`, same for every engine)

- Must-haves count twice their weight, nice-to-haves count their weight.
- Credit per verdict: MET 1, PARTIAL 0.5, UNKNOWN 0.3, NOT_MET 0.
- A deal breaker that is MET caps the score at 30. A PARTIAL deal breaker takes off 10 points.
- Recommendation: ADVANCE at 75 or more, MAYBE at 50-74, PASS below 50.

## Review engines (`review.ts`)

`REVIEW_ENGINE=jev|llm|offline`. If it's unset, the agent uses `jev` when `JEV_API_KEY` is set, otherwise `llm`, otherwise `offline`. When an engine fails, the review falls through jev → llm → offline.

**jev** (default). One request to Jev (TypeSafe System One) at `openrouter.ai/api/v1/systemone`, model `jev-latest`, using plain `fetch`.
- The state holds a short role context and the candidate's notes split into sentences (`l1`, `l2`, …).
- Each criterion gets three questions:
  - `yes`, a Noul. For a must-have or nice-to-have: "Does the candidate meet this requirement?" For a deal breaker: "Does this disqualifying condition apply?"
  - `info`, a Noul: "Do the notes say anything about it?"
  - `ev`, a Choice over the note lines plus `none`. It picks the best evidence line, which is quoted as the reasoning. If no line reaches P ≥ 0.5, the reasoning is a short template sentence instead.
- Mapping (`JEV_THRESHOLDS`):
  - **MET** when yes ≥ 0.75.
  - Otherwise **UNKNOWN** when info < 0.4.
  - Otherwise **NOT_MET** when yes ≤ 0.3.
  - Otherwise **PARTIAL**.
- The summary is one LLM call on the fast model, capped at `SUMMARY_BUDGET_MS` = 3 s, with a template as fallback.
- `reviewSubmissionDetailed` returns the raw probabilities.

**llm** has the configured LLM judge every criterion with written reasoning. **offline** uses keyword heuristics (`offline.ts`) and needs no network.

Measured on the demo fixtures (jev-1.13, Sonnet 5.5 and Haiku 4.5 via OpenRouter):

| Engine | Marta (strong) | Daniel (weak) | Latency | Cost per review |
|---|---|---|---|---|
| jev | 95 ADVANCE | 26 PASS | 2-3 s (Jev ~0.7 s, summary ~1.5 s) | ~$0.0012 (Jev ~$0.0001) |
| llm | 95-97 ADVANCE | 14 PASS | 5-8 s | ~$0.0095 |
| offline | 93 ADVANCE | 19 PASS | 0 s | $0 |

The scores above use the hand-written `criteria-senior-rust.json`. With criteria drafted by the LLM from the same job description, Jev gave 90 and 23.

## LLM providers (`llm/`)

Selection order: `LLM_PROVIDER` override > OpenRouter > Anthropic > OpenAI > offline, based on which key is set.

| Env | Effect |
|---|---|
| `LLM_PROVIDER` | `openrouter` \| `anthropic` \| `openai` \| `offline` |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Chat completions with `json_schema` structured output. Default model `anthropic/claude-sonnet-5.5` with low reasoning effort. Cost comes from `usage.cost`. |
| `OPENROUTER_FAST_MODEL` | Used for latency-critical one-liners (the review summary). Default `anthropic/claude-haiku-4.5`, no reasoning. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Default `claude-opus-5-5`, with structured outputs and server-side refusal fallbacks. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Default `gpt-6-astra`, through Responses API structured outputs. |
| `JEV_API_KEY` | An OpenRouter key for Jev. If it's missing, `OPENROUTER_API_KEY` is used. |
| `REVIEW_ENGINE` | `jev` \| `llm` \| `offline` |

Each call validates the output with zod and retries once with the validation error. If it still fails or times out, it falls back to the deterministic answer in `offline.ts` and logs a warning, so the demo works without a network. Keys are never logged. Prompts are in `prompts/*.md`.

## CLI

```bash
pnpm --filter @scout/backend agent demo                         # full chain on fixtures
pnpm --filter @scout/backend agent compare                      # jev vs llm vs offline: score, latency, cost
pnpm --filter @scout/backend agent draft jd-senior-rust-solana.txt
pnpm --filter @scout/backend agent budget criteria-senior-rust.json
pnpm --filter @scout/backend agent review criteria-senior-rust.json candidate-strong-rust.json
LLM_PROVIDER=offline REVIEW_ENGINE=offline pnpm --filter @scout/backend agent demo   # no network
```

File arguments resolve against the cwd first, then `fixtures/`. Tests: `pnpm --filter @scout/backend exec vitest run src/agent`.
