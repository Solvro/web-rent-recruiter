# Recruiting agent

The company hires the agent, not recruiters (see `docs/agent-gigs.md`). The agent turns a job description into criteria, plans the budget into paid gigs for human recruiters (sourcing, screening calls, reference checks), reviews every deliverable, pays for good work, and hands the company a shortlist.

Anything that decides money or a ranking is computed in code. Budget split, prices, scores, verdicts and accept/reject policy all live in code. The models only extract criteria, judge evidence, word scripts and write explanations. A human at the company makes the final hiring decision (the EU AI Act human-in-the-loop framing).

## Layout

| Path | What |
|---|---|
| `index.ts` | Public API, re-exports everything below |
| `llm/` | AI SDK v7 model selection (`models.ts`) and `complete()` for structured output |
| `jev.ts`, `review.ts` | Sourcing review: Jev per-criterion judgments; scoring in `scoring.ts` |
| `gigs/` | `planGigs`, call scripts, call review, shortlist, `agentDecision` policy |
| `runner/` | `createRoleAgent(ports)`: AI SDK `ToolLoopAgent`, its tools, deterministic actions, ports, in-memory ports |
| `prompts/*.md` | Every prompt, loaded at runtime |
| `fixtures/` | Demo role, candidates, screening/reference answers |

## Role agent (`runner/`)

```ts
const agent = createRoleAgent(ports);      // ports: RoleAgentPorts, implemented by the backend
await agent.runStep();                     // one autonomous pass: on funding, new deliverable, timer
await agent.chat("pause screening", history); // a company message; returns { text, messages, costUsd, mode }
await agent.advanceRole();                 // deterministic pass, no model (debug "run step now")
```

- **Tools** (thin wrappers over `runner/actions.ts`):
  - getStatus, listPendingDeliverables, planGigs, reviewDeliverable;
  - acceptDeliverable, rejectDeliverable, escalateToCompany;
  - bookScreening, bookReferenceCheck, buildShortlist;
  - adjustCriteria, pauseGigs, resumeGigs, postExtraGig, explainDecision.
- **Guards in code, not the model:**
  - Prices come from `GIG_PRICES`, and every posting checks the available budget.
  - Accept and reject only run when the stored `agentDecision` says so; anything else must escalate.
  - Escalated deliverables are never re-reviewed or re-escalated.
  - A paused gig type blocks new gigs of that type.
- **Streaming:** `agent.stream()` → `ports.onEvent` receives `text-delta`, `tool-call`, `tool-result`, `tool-error`, `finish` (with `costUsd`) and `error`.
- **No model:** `runStep` falls back to `advanceRole` and `chat` returns an offline notice. If the model errors mid-run, `runStep` also falls back to `advanceRole`.
- **Ports** (`runner/ports.ts`, canonical; the backend implements them):
  - getRole, listPendingDeliverables, getDeliverable;
  - postGig, setGigStatus, setTaskTypePaused?;
  - saveReview, getReview;
  - acceptDeliverable, rejectDeliverable, escalate;
  - updateCriteria, saveShortlist, getDecisionLog, log;
  - onEvent?.
- `runner/memory-ports.ts` is a complete in-memory implementation, used by the CLI and tests. It is the reference for how money moves: posting reserves bounty × slots, accepting pays a slot, and the available budget is deposited − paid − open reservations.

## Gigs (`gigs/`)

- **`planGigs({criteria, title, budget, seniority?})`** → `{ gigs, rationale, committed, reserve }`.
  - `splitBudget` is deterministic: 20% reserve, then 3 screenings and 1 reference by default, and the rest to sourcing in steps of 5 (5-30).
  - Small budgets drop screenings first, then the reference. Large ones add screenings (up to 5) and a second reference.
  - Example: $300 senior → 20 × $5 sourcing, 3 × $35 screening, 1 × $25 reference, $70 reserve.
  - The LLM writes only the briefs and the rationale.
- **`screeningScript` / `referenceScript`** → `CallScript`.
  - Code picks the question slots with stable ids (`q-<criterionId>`, `q-motivation`, `q-logistics`; `ref-relationship|strength|verify|growth|rehire`).
  - Screening has 6-8 questions: must-haves first, with those the sourcing review left unclear asked first, then deal breakers.
  - The LLM words each question and its `whatGoodLooksLike`.
- **`reviewScreening` / `reviewReference({script, answers, recommendation, transcript?})`** → `CallReview`.
  - One Jev request asks four Nouls per answer: addressed, specific, fit (matches `whatGoodLooksLike`) and contradicts. One more Noul checks whether the recommendation is consistent with the answers.
  - Code turns that into the verdict (`CALL_THRESHOLDS`). Per-answer quality is 0 for missing, 0.35 for generic, and 0.6-1.0 for specific answers.
  - **ACCEPT**: score ≥ 70, at most 1 missing answer, no contradictions, and a consistent recommendation.
  - **REJECT**: fewer than half the questions answered, score < 45, or 2+ contradictions.
  - **ESCALATE**: anything else.
  - `candidateFit` is the signal about the candidate; the verdict judges the recruiter's work.
  - The summary is one fast-model call capped at 3 s, with a template fallback.
- **`shortlist({role, candidates})`** → entries ordered by stage reached, then `overall`.
  - `overall` blends sourcing 0.4, screening fit 0.4 and reference fit 0.2; rejected calls are ignored.
  - The LLM writes one paragraph per candidate.
- **`agentDecision({kind, review})`** (`POLICY`):
  - Sourcing: accept at ≥ 60 unless the recommendation is PASS, escalate at 50-59, reject below.
  - Calls: ACCEPT → accept, REJECT → reject, ESCALATE → escalate.
- **`pickForScreening`**: ADVANCE (≥ 75) candidates first, at most 3 at a time. If nobody reaches 75 and nothing is booked yet, it screens the best accepted candidate.

## Sourcing review (`review.ts`)

`REVIEW_ENGINE=jev|llm|offline`. The default is Jev when a key is set, and a failure falls through jev → llm → offline. Jev asks three questions per criterion: a `yes` Noul, an `info` Noul and an evidence Choice over the note lines.
- MET when yes ≥ 0.75.
- Otherwise UNKNOWN when info < 0.4.
- Otherwise NOT_MET when yes ≤ 0.3.
- Otherwise PARTIAL.

Scoring (`scoring.ts`): must-haves count twice their weight, and credit is MET 1, PARTIAL 0.5, UNKNOWN 0.3, NOT_MET 0. A triggered deal breaker caps the score at 30. Recommendations: ADVANCE at 75 or more, MAYBE at 50-74.

## Models (`llm/`)

`complete()` uses AI SDK `generateText` + `Output.object`, sends a strict JSON schema and validates with zod. It retries once, then falls back to the offline answer. Provider order: `LLM_PROVIDER` > OpenRouter > Anthropic > OpenAI > offline.

| Env | Default | Use |
|---|---|---|
| `OPENROUTER_API_KEY` | none | Default provider (`@openrouter/ai-sdk-provider`; cost read from provider metadata) |
| `OPENROUTER_MODEL` | `openai/gpt-6-luna` ($0.10/$0.50 per M tokens) | Main model and agent loop. **Cheap by default; use `anthropic/claude-sonnet-5.5` for the live demo** |
| `OPENROUTER_FAST_MODEL` | `google/gemini-2.5-flash-lite` ($0.10/$0.40 per M tokens) | Latency-critical one-liners (summaries) |
| `JEV_API_KEY` | falls back to `OPENROUTER_API_KEY` | Jev System One through OpenRouter |
| `REVIEW_ENGINE` | `jev` if a key is set | `jev` \| `llm` \| `offline` |
| `LLM_PROVIDER` | auto | `openrouter` \| `anthropic` \| `openai` \| `offline` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_FAST_MODEL` | `claude-opus-5-5`, `claude-haiku-4-5` | Alternative provider |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_FAST_MODEL` | `gpt-6-astra`, `gpt-6-luna` | Alternative provider |

Measured on the demo with the cheap defaults:
- Sourcing review: about 1 s and $0.0002.
- Screening review: about 1-3 s.
- A full simulated role run (plan → 3 profiles → 2 screenings → reference → shortlist): about $0.003 of LLM cost plus Jev, with 13-36 s per agent step.
- A chat turn: 3-13 s and $0.0001-0.0005.

## CLI

```bash
pnpm --filter @scout/backend agent run                 # role agent on simulated recruiters + 3 company chat turns
pnpm --filter @scout/backend agent chat "why did you reject Piotr?"
MODE=deterministic pnpm --filter @scout/backend agent run   # same flow, no model (advanceRole)
pnpm --filter @scout/backend agent demo-gigs           # gig functions step by step
pnpm --filter @scout/backend agent plan 300 | script [reference] | review-screening screening-lazy.json
pnpm --filter @scout/backend agent demo | compare | draft <jd> | budget <criteria> | review <criteria> <candidate>
LLM_PROVIDER=offline REVIEW_ENGINE=offline pnpm --filter @scout/backend agent demo-gigs   # no network
```

Tests (offline, no network): `pnpm --filter @scout/backend exec vitest run src/agent`.
