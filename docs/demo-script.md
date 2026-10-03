# Live demo (3 minutes, Superteam jury)

Demo role: **Senior Rust Engineer (Solana programs)** at a seed-stage Solana DeFi startup in Warsaw (Hanna Lewicka). Fixtures: `backend/src/agent/fixtures/demo-*`.

What the jury should remember: **an AI agent hires people with its own budget, checks their work, and pays them instantly on Solana. The company only signs once.**

## Gigs in the demo (and why)

| Gig | Price | Why it sells |
|---|---|---|
| **Find candidates** (SOURCING) | $25 / confirmed profile (senior, rare; base $12 × seniority) | Many small payouts. The agent filters (one rejected with a reason), and payment needs the candidate's own confirmation. |
| **Screening call** (SCREENING_CALL, recorded by the notetaker bot) | $40 / accepted call | This is the real pre-client step agencies run before sending a candidate. The proof is a transcript: the agent checks it against its own questions. Shows holdback: 70% now, 30% when the candidate reaches the company. |
| **Language check** (SCREENING_CALL variant, 15 min, English C1) | $15 | Same on-chain gig type with a different script. Shows the agent can compose new gigs without new contracts. |
| **Reference check** (REFERENCE_CHECK) | $25 | Shown in the shortlist, not clicked live. |

Gigs that are only on the roadmap slide:
- warm intro paid for a confirmed "yes" from the candidate (the proof comes from the candidate),
- take-home review,
- employment verification,
- interview coordination,
- a 30/90-day check-in that releases the holdback.

Never sell minutes or hours.

## The $750 plan (agent's plan for the demo role)

| Gig | Count × price | Total |
|---|---|---|
| Find candidates (senior Rust/Solana, rare profile; paid on the candidate's confirmation) | 17 × $25 | $425 |
| Screening call (30 min, recorded) | 3 × $40 | $120 |
| Language check (English C1) | 1 × $15 | $15 |
| Reference check | 1 × $25 | $25 |
| Reserve (repricing, extra sourcing) | | $165 |
| **Budget** | | **$750** |

Pitch line: **$750 of verified work vs an agency fee of ~20% of an annual salary** (public benchmark).

## Exact payouts (from `math::split`: 10% fee, 10% operator when vouched, 30% of the recruiter's share held back; every percentage floored, dust to the recruiter)

| Gig | Recruiter | Fee | Operator | Now | Held back | Total to recruiter |
|---|---|---|---|---|---|---|
| Sourcing $25 | **Lucía** (unvouched; posts a $2.50 bond, returned on accept) | $2.50 | – | **$15.75** | $6.75 | $22.50 |
| Sourcing $25 | vouched | $2.50 | $2.25 | $14.175 | $6.075 | $20.25 |
| Screening $40 | **Ola** (vouched by Kraków Recruiting Academy) | $4.00 | $3.60 | **$22.68** | $9.72 | $32.40 |
| Screening $40 | unvouched | $4.00 | – | $25.20 | $10.80 | $36.00 |
| Language check $15 | vouched / unvouched | $1.50 | $1.35 / – | $8.505 / $9.45 | $3.645 / $4.05 | $12.15 / $13.50 |
| Reference $25 | vouched / unvouched | $2.50 | $2.25 / – | $14.175 / $15.75 | $6.075 / $6.75 | $20.25 / $22.50 |
| Tech screen $100 (not in the demo) | vouched / unvouched | $10.00 | $9.00 / – | $56.70 / $63.00 | $24.30 / $27.00 | $81.00 / $90.00 |

The company always pays exactly the price. The UI shows the amounts the API returns; display rounding shows "now" to the cent and derives "later" as total − displayed now.

## Script

Sourcer and screener must be different people (program v3.1 `subject_scout`), shown live: **Lucía** (unvouched, posts a small bond) sources Karolina and sends her the confirmation link; **Ola** (vouched by Kraków Recruiting Academy, screening-eligible) runs Karolina's screening with the notetaker.

| Time | Who | Action | What to say |
|---|---|---|---|
| 0:00 | Hanna (company) | Paste the job description. The agent shows its plan: gigs with prices and a $750 budget. Click "Start agent". | "Hanna hires an agent, not an agency: $750 of verified work instead of an agency fee of ~20% of an annual salary. One signature puts it into a program vault." (Solscan link) |
| 0:40 | Lucía (recruiter) | The gig board: "Find candidates". She pays a small deposit (not vouched). Paste Karolina and Piotr. Piotr is rejected with a reason; Karolina is pre-accepted and Lucía gets a link for her. Open it in a second tab as Karolina, click "Yes, I'm open to a conversation". Lucía is paid **$15.75 now** (plus her $2.50 deposit back) and **$6.75** when Karolina reaches the interview. | "The agent filters, but nobody is paid for a link. The money moves when the candidate herself says yes." |
| 1:20 | Ola (recruiter) | The agent has posted a screening for Karolina. Lucía can't take it (she sourced her); Ola can. Ola takes it and pastes the Meet link; the notetaker records (mock transcript in the demo), the answers are pre-filled from the transcript, Ola submits. The agent accepts: **$22.68 now, $9.72 later**; Kraków Recruiting Academy gets $3.60. | "The person who found the candidate can't grade them. The proof is the recorded call; a lazy or pasted transcript gets rejected." |
| 2:10 | Hanna | The agent thread shows every step. Ask "why did you reject Piotr?" Open the shortlist, click "Invite to interview". Then, after the interview, "Came to the interview": the held parts are released to Lucía and Ola. | "The human keeps the hiring decision. The last 30% only arrives when the candidate actually shows up." |
| 2:40 | Anyone | Ola's public profile shows on-chain reputation per gig type, then the Solscan transaction signed by the agent. | "Reputation belongs to the recruiter. Any agency or agent can post gigs to the same program." |

## Before the demo

- `pnpm reset:demo && pnpm seed --reset`, restart the backend.
- `DEMO_FAST=1` so agent steps take under 5 s: deterministic policy, Jev scoring, and the LLM only for chat and plan text. Short holdback window only in demo mode (default is 14 days).
- `RECALL_MOCK=1` unless there is a live Meet ready.
- Keep the backup recording and `?data=mock` ready.
