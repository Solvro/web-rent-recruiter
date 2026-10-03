# Quality and reputation

Global, instant payouts are worthless if the work is bad. This document designs how Scout keeps the quality of external recruiters' work high and lets the marketplace regulate itself over time. Some of it is enforced by the program and some is computed off-chain.

Scope:
- **Task types:** `SOURCING` (deliver a qualified, interested candidate) and `SCREENING_CALL` (a 30-minute structured screening call with notes, the step agencies run before sending a candidate to a client).
- **Operators:** open to third-party operators who plug into the protocol, in a franchise-like model. They recruit and train recruiters, may run their own UI, and take their own fee.

## Design principles

1. **Pay for outcomes that are hard to fake.** "Accepted by the company" is a weak signal. "The candidate showed up to the client interview" is a strong one. Tie money and reputation to the strongest signal that arrives soon enough.
2. **Make a fresh identity worse than any honest history.** If a new wallet starts with more access than a bad one, Sybil resets are free. Newcomers must start capped.
3. **Make the person who vouches carry the risk.** Operators that bring recruiters in share their downside, so they filter before we have to.
4. **Keep it legible.** Counters live on-chain, and scores are a public formula over those counters. Anyone can recompute any recruiter's score. We never act as a hidden judge.

## 1. Threat model

| # | Threat | Who gains | What it looks like | Damage |
|---|---|---|---|---|
| T1 | Spam submissions | Recruiter | Many low-fit candidates submitted hoping some get accepted (or auto-accepted by silence) | Company time is wasted, the vault drains, trust dies |
| T2 | Fake or low-effort screening notes | Recruiter | A call that never happened, or notes copied from the CV | Clients get bad candidates, and the core value of an agency (vetting) is gone |
| T3 | Recruiter ↔ candidate collusion | Both | A friend posing as "interested", a candidate paid to show up once | Payout for a candidate who will never be hired |
| T4 | Recruiter ↔ company collusion | Both | A company accepts its accomplice's submissions to farm reputation or launder money | Inflated reputation, which is then sold or used to reach premium roles |
| T5 | Sybil reset | Recruiter | A bad recruiter opens a new wallet to escape history | Reputation means nothing |
| T6 | Company rejects good work | Company | Rejects before the deadline, then contacts the candidate directly | Recruiters leave, and supply dies |
| T7 | Company ghosts | Company | Never decides | Already solved: silence = acceptance (`settle_expired`) |
| T8 | Operator gaming | Operator | Onboards masses of unvetted recruiters to collect operator fees, or rotates operator identities | Same as T1 and T5, but at scale |
| T9 | Agent manipulation | Recruiter | Notes written to game the AI scorer ("prompt-injected" notes, keyword stuffing) | AI score inflated, review time misallocated |

## 2. Mechanisms

Legend: **H** = buildable in the hackathon, **R** = roadmap.

### M1. Outcome-based reputation (H for counters, R for decay and segmentation)

- **Fixes:** T1, T2, T3 and partly T4.
- **What:** reputation is built from downstream outcomes, not from volume. For each recruiter (and later each task type and role family) count four things: `accepted`, `advanced` (the candidate reached a client interview, or for SCREENING_CALL the notes were confirmed useful), `hired`, and `flagged` (proven misrepresentation).
- **On-chain:** lifetime counters on `ScoutProfile`, updated by `accept`, `settle`, `reject` and a new `attest_outcome` instruction.
- **Off-chain:** time decay and per-role-family breakdowns. The indexer has every event with timestamps; storing time-decayed values on-chain would need a crank and costs more than it is worth.
- **Score:** a public formula over the on-chain counters, Bayesian-smoothed so a 1/1 newcomer does not outrank a 40/50 veteran.

```
quality  = (advanced + 3·hired + α) / (accepted + α + β)    α = 2, β = 3 (prior ≈ 0.4)
penalty  = 0.5 ^ flagged
score    = round(100 · quality · penalty)
```

- **Cost:** low, a few fields and one instruction.

### M2. Escrow holdback (H)

- **Fixes:** T2, T3 and T6, and it sharpens the incentive of M1.
- **What:** on acceptance the recruiter is paid `bounty · (1 − holdback_bps)` immediately. The remaining `holdback` stays reserved in the vault until one of three things happens:
  - the company or agent attests `Advanced` (the candidate attended the client interview), which releases the holdback to the recruiter;
  - `holdback_deadline` passes, which lets anyone release it to the recruiter permissionlessly. This is silence = acceptance again, so the company cannot hold the money hostage;
  - the company attests `Fabricated` with a reason code before the deadline. The holdback is refunded to the company and the recruiter's `flagged` counter goes up.
- **On-chain:** yes. This is the core money rule and belongs in the program.
- **Company abuse (T6):** a fabricated-claim refund only returns the holdback (e.g. 30%), never the paid part, and the company's `fabricated_claims` counter becomes public (M4). Lying is cheap per case but visible in aggregate.
- **Cost:** moderate. Two fields on Submission, one reserved total on RoleVault, one instruction, and one more term in the vault invariant.

### M3. Agent QA on deliverables (H as off-chain review, R for evidence on-chain)

- **Fixes:** T2 and T9.
- **What:**
  - **Rubric check** of screening notes. The agent checks every required section (motivation, notice period, salary expectation, must-have verification, red flags), demands concrete answers rather than CV restatements, and verifies consistency with the candidate's public profile. A low rubric score becomes a warning for the company, not an automatic reject; the human still decides.
  - **Evidence hash:** for SCREENING_CALL the recruiter attaches a transcript or recording; only `sha256(evidence)` goes on-chain (`Submission.evidence_hash`). Disputes later compare against it. No personal data goes on-chain.
  - **Candidate confirmation:** the candidate gets a one-click link ("Did you have a call with Ola about the Backend role? 👍/👎 + 1–5"). This is cheap, two-sided and very hard to fake at scale. It counts as an `advanced`-strength signal for SCREENING_CALL.
  - **Calibration:** randomly double-screen about 5% of screenings by a top-tier recruiter, paid from the platform fee. Large disagreements flag the original screener for review.
  - **Injection hardening:** recruiter notes are data, never instructions. Jev Nouls per criterion are robust here, because they answer fixed questions over the text rather than following it.
- **Cost:** mostly prompt and UI work. The candidate-confirmation link is about one endpoint and one page.

### M4. Company reputation (H, cheap)

- **Fixes:** T6, and it makes recruiters willing to work for strangers.
- **What:** a `CompanyProfile` PDA counting `roles`, `accepted`, `rejected`, `auto_settled` (times the company let the window lapse) and `fabricated_claims`, plus an off-chain `avg_time_to_decide`. Recruiters see, for example, "Accepts 62% · decides in ~9h" on every task card.
- **On-chain:** the counters, updated inside existing instructions.
- **Cost:** one account, plus updates inside existing handlers.

### M5. Tiers and access gating (H as a simple threshold, R for full tiers)

- **Fixes:** T1, T5 and T8.
- **What:** newcomers get capped concurrency, for example at most 3 pending submissions across all roles, and access only to roles without a reputation threshold. Each role can set `min_scout_score` (or the simpler `min_scout_accepted`), so premium roles with higher bounties are reserved for proven recruiters.
- **Why this kills Sybil resets:** a fresh wallet is capped and locked out of the good roles, so starting over is always worse than keeping an honest record. A recruiter with a bad score is stuck below the newcomer floor only after flags, and flags also hit their operator (M7).
- **On-chain:** the `min_scout_accepted` check in `submit_candidate` (H). The global concurrency cap needs `ScoutProfile.pending` (H, one counter).
- **Cost:** low.

### M6. Sybil resistance (R, partly H)

- **Fixes:** T5 and T4.
- **What:**
  - **Soulbound reputation:** the `ScoutProfile` PDA is seeded by the wallet and has no transfer instruction, so reputation cannot be sold. It is already soulbound today.
  - **Personhood:** a verified LinkedIn or KYC check, done by an operator and recorded as `verified_by: Option<Pubkey>` on the profile. Scout itself never stores identity documents.
  - **Collusion weighting:** the off-chain score counts only the first N accepts per (recruiter, company) pair at full weight. Reputation from a single counterparty is discounted, which makes T4 farming expensive: it costs real bounties plus fees and earns little.
  - **Stake:** see M8.
- **Cost:** weighting is off-chain and cheap. Personhood depends on operators.

### M7. Operator layer, the franchise model (H for minimal routing, R for bonds)

- **Fixes:** T8, and it is the growth engine.
- **What:** an operator is any company that recruits, trains and supports recruiters (a bootcamp, a regional agency, a better recruiter UI). It registers an `Operator` account with its own `fee_bps`.
  - **Vouching:** a recruiter joins under an operator, and the operator co-signs `register_scout`.
  - **Payout split:** on every payout the operator's fee is split from the recruiter's side, so the company still pays only the bounty. The split is `scout / operator / treasury`.
  - **Public quality:** aggregate counters on `Operator` (recruiters, accepted, advanced, flagged), so operators compete on quality.
  - **Pooled bond (R):** the operator posts a bond. Flags on its recruiters slash it, and below a quality floor the operator loses the right to vouch for new recruiters.
- **Why it matters for the pitch:** we don't need to recruit and train 10 000 recruiters ourselves. Operators do it and earn from it, and we earn the protocol fee. It is global from day one, because operators in any country can plug in.
- **On-chain:** the `Operator` account, `ScoutProfile.operator` and the 3-way split (H). Bond and slashing are R.

### M8. Stake and slashing (R)

- **Fixes:** T1, T2 and T5 at scale.
- **What:** recruiters (or their operator) lock a bond of a few multiples of the average bounty. Proven fabrication slashes part of it to the company. It is permissionless, but it needs an honest adjudication path (M9), otherwise slashing becomes the company's weapon (T6).
- **Why not now:** a bond is a barrier for exactly the users we target (non-technical freelancers), and slashing without disputes is unsafe. Operators can post the bond for their recruiters, which removes the barrier.

### M9. Disputes (R)

- **What:** when a company attests `Fabricated` and the recruiter contests, the dispute goes to the recruiter's operator first, then to a staked panel of top-tier recruiters (Kleros-style), using the evidence hash from M3. The losing side pays the panel. Until this exists, `Fabricated` only claws back the holdback and is publicly counted against the company (M2, M4). That bounds the damage either way.

## 3. On-chain data model extension

Same conventions as [program-interface.md](../program-interface.md). All amounts are in base units. Every instruction keeps the separate `payer`.

### Hackathon build: minimal additions

| Account | New fields |
|---|---|
| `RoleVault` | task_type: TaskType {Sourcing, ScreeningCall}, holdback_bps: u16, holdback_window_seconds: i64, held_back_total: u64, min_scout_accepted: u16 |
| `ScoutProfile` | advanced: u32, flagged: u32, pending: u16, operator: Option<Pubkey> |
| `Submission` | holdback_amount: u64, holdback_deadline: i64 (0 = none), outcome: Outcome {None, Advanced, Hired, Fabricated}, evidence_hash: [u8; 32] (zero for SOURCING) |
| `Operator` (new, `["operator", authority]`) | authority, fee_bps: u16 (≤ 2000), treasury_token_account, recruiters: u32, accepted: u32, advanced: u32, flagged: u32, bump |
| `CompanyProfile` (new, `["company", company]`) | company, roles: u32, accepted: u32, rejected: u32, auto_settled: u32, fabricated_claims: u32, bump |

New or changed instructions:

| Instruction | Args | Signers | Effect |
|---|---|---|---|
| `register_operator` | fee_bps: u16 | payer, authority | Creates Operator. |
| `register_scout` (changed) | none | payer, scout, operator authority (optional) | If an operator signs, sets `profile.operator` and increments `operator.recruiters`. |
| `create_role` (changed) | + task_type, holdback_bps (≤ 5000), holdback_window_seconds, min_scout_accepted | payer, company | Also `init_if_needed` CompanyProfile and increments roles. |
| `submit_candidate` (changed) | candidate_hash, evidence_hash: [u8; 32] | payer, scout | Adds checks: `profile.accepted ≥ role.min_scout_accepted`, and `profile.pending < 3` while `profile.accepted < 5` (newcomer cap). Funding invariant: `vault ≥ (pending + 1)·bounty + held_back_total`. Increments `profile.pending`. |
| `accept_submission` / `settle_expired` (changed) | none | as before | `hb = bounty·holdback_bps/10000`. Pays the scout `bounty − fee − op_fee − hb`, the operator `op_fee = (bounty − fee)·op.fee_bps/10000`, and the treasury `fee`. Reserves `hb` (held_back_total += hb), sets the holdback deadline, and updates the company counters (accepted or auto_settled). |
| `attest_outcome` (new) | outcome: Outcome, reason_code: u8 | payer, company or role.agent | Accepted submissions only, and only one attestation per stage. `Advanced`/`Hired`: increments profile and operator advanced, releases the holdback to the scout. `Fabricated` (only before the holdback deadline): refunds the holdback to the company, increments `profile.flagged`, `operator.flagged` and `company.fabricated_claims`. |
| `release_holdback` (new) | none | payer (anyone) | After `holdback_deadline` with outcome None, pays the holdback to the scout (silence = success). |
| `close_role` (changed) | none | payer, company | Also requires `held_back_total == 0`. |

New event: `OutcomeAttested { role_vault, submission, scout, operator, outcome, released }`.

Rough size: about 150 extra lines in the program, one new test file, and the payout math touches `payout.rs` only.

### Roadmap

- **Staking:** `Bond` (`["bond", owner]`, where owner is a recruiter or operator) holding amount, locked and unbonding_until; `deposit_bond`, `request_unbond`, `withdraw_bond`; `slash(amount)` callable only by dispute resolution.
- **Disputes:** `Dispute` (`["dispute", submission]`) holding opened_by, evidence hashes, a panel of Pubkeys, votes, deadline and a stake per side; `open_dispute`, `vote`, `resolve`.
- **Per-task-type and per-role-family counters:** separate `ScoutProfile` PDAs seeded by `["scout", scout, task_type]` rather than growing one account. The UI aggregates them.
- **Verified personhood:** `ScoutProfile.verified_by: Option<Pubkey>`, set by an operator with a `kyc` capability flag.
- **Agent outcome attestations:** the agent attests `Advanced` automatically from ATS webhooks (Ashby/Greenhouse), so companies don't have to click.

## 4. Critique: a skeptical reviewer

Written as a marketplace and crypto-economics reviewer who wants to break this.

1. **"Your strongest signal is self-reported by the party that profits from lying."** `Advanced` and `Fabricated` are attested by the company, which saves the holdback by claiming fabrication. *Answer:* the holdback is bounded (e.g. 30%), the deadline defaults to the recruiter, and `fabricated_claims` is public, so a company that lies loses its supply. That is bounded and visible, not trustless. Say this plainly. ATS-sourced attestation removes much of it later.
2. **"Holdback re-introduces waiting, which is the very problem you said you solve."** Partly true. Answer with numbers: 70% arrives in seconds instead of everything in 56–90 days, and the rest within about 2 weeks by default. Make `holdback_bps` per role and allow 0 for trusted pairs. Don't oversell "instant".
3. **"The score formula is arbitrary."** It is, and so is every marketplace's. What's different is that ours is public and recomputable from on-chain counters, and companies can set their own thresholds. Don't spend demo time defending α and β.
4. **"Sybil resistance via operators just moves the problem to operators."** Yes, intentionally. There are tens of operators, not tens of thousands of recruiters, they are easier to vet, and in the roadmap they are bonded. This mirrors franchise and payment-facilitator models, so call it a feature.
5. **"Collusion farming is still possible with real money."** It costs at least the bounty plus fee per fake success, and counterparty-diversity weighting makes single-company farming nearly worthless. Good enough; don't claim more.
6. **"Over-engineered for 24 hours."** Staking, slashing, disputes, per-family segments and personhood are clearly roadmap; building any of them now would weaken the demo. Even the full hackathon table above is too much. Pick three (below).
7. **"Why on-chain at all? A database does this."** The counters matter on-chain because they are portable across operators and UIs, which is what makes the open protocol possible: a recruiter trained by operator A keeps their record when they work through operator B's app. A database owned by one marketplace cannot offer that.
8. **"Screening notes quality can't be measured by an LLM."** Agreed, not fully, so the LLM only flags, while candidate confirmation and downstream `Advanced` decide. Keep the human in the loop (EU AI Act framing).
9. **"Judges will ask what happens when the company and recruiter disagree."** The answer today: the holdback is the only contested money, it is bounded, and the counters are public. The answer next: operator mediation, then a staked panel with the evidence hash.

## 5. Recommendation

**Build now (three things, in this order):**

1. **`task_type` plus a SCREENING_CALL task with `evidence_hash`**, and the candidate-confirmation link off-chain. This matches the real 30-minute screening agencies run before a candidate goes to the client, and makes the agent → human task story concrete. Program change: `RoleVault.task_type`, `Submission.evidence_hash`, an extra `submit_candidate` argument.
2. **Escrow holdback plus `attest_outcome` / `release_holdback`**, with `advanced` and `flagged` on `ScoutProfile`. This is the core quality loop: money and reputation follow a downstream signal, with silence still defaulting to the recruiter. Program change: the holdback fields above, two instructions and the extended invariant.
3. **Operator account plus a 3-way payout split**, with `ScoutProfile.operator`. This is the franchise and open-protocol story, visible in the demo as an "Operator: Kraków Recruiting Academy · 10%" line on the payout. Program change: the `Operator` PDA, the `register_scout` co-sign and the split in `payout.rs`.

Skip for now and mention on a slide: `CompanyProfile` (put it on the roadmap slide), the newcomer cap and min-score gating (one `require!`, so add it only if time allows), staking, slashing, disputes, personhood and decay.

**Two sentences for the slide:**

> Recruiters are paid most of the fee instantly and the rest when the candidate actually shows up at the client interview. Every outcome lands in a public, portable reputation record that operators, who train and vouch for their recruiters, put their own stake behind.

## Appendix: score example

| Recruiter | accepted | advanced | hired | flagged | score |
|---|---|---|---|---|---|
| Newcomer | 1 | 1 | 0 | 0 | (1+2)/(1+5) = 50 |
| Solid | 40 | 22 | 6 | 0 | (22+18+2)/(40+5) = 93 |
| Volume spammer | 60 | 6 | 0 | 2 | (6+2)/(60+5)·0.25 = 3 |

The point to show judges: volume without outcomes scores near zero, and every proven fabrication halves the score.
