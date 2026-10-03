# Jury Q&A

## The five official questions (short)

1. **Where does the intermediary disappear?** `accept_submission.rs` → `payout.rs::pay_out` → `math.rs::split` (one-transaction payout from the PDA vault); `settle_expired.rs::handle_settle_expired` (no signer needed after the window); `create_task.rs` (company-signed agent caps); `invariants.rs::check_role`/`check_task`.
2. **A party disappears mid-transaction:**
   - **Company silent:** `settle_expired` and `release_holdback` (anyone can call them) pay the recruiter.
   - **Recruiter silent:** nothing is owed, and `release_claim` frees the gig.
   - **We disappear:** funds stay in the vault, non-sourcing work settles permissionlessly, sourcing waits for the attestor or the company, and `close_role` refunds the company. New deliverables stop until the company names another agent (`set_agent`) or gates the role itself.
3. **Who can do what, and can we change anything?** See the authority table in the README.
   - The fee is snapshotted per role.
   - `update_config` changes the fee only within bounds and only for new roles.
   - The real power we keep is the upgrade authority, a cold key. A multisig and then immutability are on the roadmap.
4. **Why blockchain:** custody by the program, payout atomic with acceptance, silence can't block payment, the company can fire our agent without us, global payouts, recruiter-owned reputation.
5. **Next week:** README "Next".

**Sourcing liveness trade-off (honest):**
- A silent *sourcing* deliverable is **not** paid by anyone after the window. Only the task's `confirmation_attestor` (any key, by default the role's agent) or the company can settle it, because the payment depends on the candidate's confirmation.
- So if the attestor disappears, a sourcing payout waits for the company. That is a liveness dependency, not custody: the money stays reserved in the vault, and the company can always settle or close.
- Non-sourcing deliverables (screening, language, reference) remain permissionlessly settleable after the review window.

**Did the backend become the intermediary?** No. Scout is a protocol (program + open agent API), and our hosted agent is one implementation.
- **(a) Money and payout rules are enforced by the program, regardless of us:** custody in the PDA vault, `math::split`, `settle_expired`, `close_role` refunds, `SelfDealing`/`subject_scout`, bonds and company-signed agent caps.
- **(b) Judgement is done by a reviewer the company chooses:** our Scout agent (default), its own self-hosted agent (`scout-agent` CLI in `packages/agent`, its own key as gatekeeper; done, covered by the protocol e2e) or the company itself. The gatekeeper is the agent or the company (v3.3, live), switchable any time with `set_agent`. `review_hash` / `reason_hash` are on-chain (live), and appeals are live: the recruiter appeals a rejection (`submissions.appeal`), the company decides (`decideAppeal`), and an overturn pays the recruiter directly.
- **(c) What still depends on us:** our reference implementation's availability (service, not custody) and the upgrade key (multisig, then immutability, on the roadmap).
- **What a bad reviewer can still do:** reject good work. The company can replace it, the reason is on-chain, and the recruiter can appeal (`submissions.appeal`; an overturn pays directly).

Answers to the 15 hardest questions from our own mock jury (a Rust/Solana engineer and a growth/business lead). Status labels:

- **done**: built and tested; the test name is given.
- **in progress**: nothing on the critical path; remaining items are roadmap. Program items are live on devnet as v3.3 ([upgrade tx](https://solscan.io/tx/Jbbm8wdm9xixPncFTcbqcVceffA8vwioPRPW2pZtydeHkg7e9A8UcPA5HvFpN5ruDEpPVCQjKwC5DiGLCcr7eMq?cluster=devnet)).
- **roadmap**: not built. We say so.

Tests live in `tests/scout.ts` (program, Surfpool) and `programs/scout/src/math.rs` (Rust unit tests and proptests).

## 1. "I call `submit_deliverable` with random hashes directly on-chain, wait, then `settle_expired`. Who stops me?"

- **done (v3.3 on devnet; `submit_deliverable.rs` `gatekeeper` constraint, `RoleVault::gatekeeper()`):** `submit_deliverable` and `claim_task` need the role's gatekeeper (`role.agent`, or the company if there is none) as a co-signer. The agent only co-signs deliverables that came through the API and were stored, so a direct on-chain submit fails. "Silence = acceptance" then applies only to work the agent has seen.
- **done (backend):** defence in depth. The indexer auto-rejects any on-chain submission without a database row, signed by the agent.
- **done:** sourcing payouts no longer move on the agent's score alone. The agent pre-accepts, and the candidate must confirm interest through a one-click link (`/c/<token>`, Memo proof on the accept tx) before the agent accepts on-chain. Exclusive gigs can be gated by reputation (`Task.min_accepted`, v3.1).
  - Tests: "separation of duties + reputation gate; an independent screening flags the sourcer (clawback)".

## 2. "Your sourcing review checks the recruiter's own claims, not the candidate. Show me a fake profile getting rejected."

- **Honest answer:** the agent judges what the recruiter wrote. It does not verify that the profile exists. An LLM-written note can score well.
- **What stops payment:**
  - The money moves only after the **candidate confirms interest** via a link the recruiter must get to them (done).
  - Auto pre-accept only at ADVANCE (≥ 75); MAYBE escalates to the company.
  - Unvouched recruiters post a **bond** (10%) that the company keeps on reject (v3.1). Test: "bond: an unvouched scout posts it, gets it back on accept, loses it to the company budget on reject".
  - A fake candidate is caught at the **screening by a different recruiter** (sourcer ≠ screener, v3.1). `attest_outcome(Fabricated)` then claws back the sourcer's held-back 30% and flags them. Test: "separation of duties + reputation gate; an independent screening flags the sourcer (clawback)".
- **roadmap:** profile existence checks through an enrichment API.

## 3. "One agent key signs for every role. If it leaks, how much is lost?"

- **done:** the agent can't pay itself or the company. Test: "self-dealing: neither the agent nor the company can deliver to their own role". It has no authority over roles it isn't the agent of. Test: "an agent has no authority over a role it isn't the agent of".
- **done (v3.3 on devnet):**
  - company-signed caps per role, `agent_max_bounty` per task and `agent_max_commitment` in total (checked in `create_task.rs`);
  - a company-only `set_agent` to revoke or rotate the agent (`set_agent.rs`);
  - the agent's co-signature on submissions, so a stolen key still needs real deliverables that land in our database.
  - A leaked key is then bounded by those caps, not by the vault.
- **done:** a company can run its own agent with its own key (`scout-agent`, `packages/agent`).
- **roadmap:** a per-role agent key in a KMS/HSM for our hosted agent.

## 4. "How does the API know who I am?"

- **Before:** the API trusted an `x-wallet` header. The jury was right; this was the worst hole.
- **done:** Sign-In-With-Solana sessions. `x-wallet` is no longer trusted; `checkDuplicate` is behind a session.
  - The app signs a nonce with the wallet (the Privy embedded wallet or a demo keypair).
  - The backend issues a short-lived session, and the tRPC context reads the wallet only from that session.
  - Company-only data (shortlists, activity, candidate details) checks that the caller is that role's company.

## 5. "Who can upgrade the program?"

- **Today on devnet:** the deployer key, which was also the relayer and the treasury.
- **done:** separate keys (`deployments/devnet.json`).
  - The relayer is only a fee payer.
  - The treasury is its own wallet.
  - The upgrade authority is a cold key that the backend never loads.
- **done:** `initialize_config` can only be called by the upgrade authority (it reads ProgramData), so nobody can front-run setup and pick the mint or treasury.
- **done (v3.3):** fee and window bounds, plus an admin-only `update_config` so the treasury can rotate without an upgrade.
- **roadmap:** a Squads multisig with a timelock as upgrade authority, and a verifiable build. The fee is snapshotted per role, so a fee change never touches a running role.

## 6. "Screeners can earn a share of a success fee. Why would a good screener take $32 net?"

- **Today:** freelance screeners are typically paid only by the promise of a success fee if the candidate is eventually hired. For most calls that promise never pays (our hypothesis from our design partner; we share the numbers live).
- **What screeners want** is steady income, not a lottery. Per-call pay of $32.40–36.00 on a $40 screen ($22.68–25.20 at acceptance, the rest when the candidate reaches the company) gives them that.
- **For companies who want both:** guaranteed per-call pay plus an optional hire bonus. Our holdback already pays the last 30% when the candidate reaches the company. A separate on-hire bonus is roadmap. The hybrid is an option, not a requirement.
- **No LOI yet.** The pilot converts work that is already happening unpaid; it doesn't recruit new supply.

## 7. "I can mint a perfect reputation for free, can't I?"

- **Today:** yes. With a 9-base-unit bounty, the fee floors to 0 and an attacker can accept their own work as a "company".
- **done (v3.3):**
  - a minimum bounty (≥ 1 USDC);
  - a minimum fee;
  - reputation counted only for bounties at or above the minimum.
- **done:** an agent or company can't deliver to its own role (`SelfDealing`).
- **done:** a reputation score with skills and gig requirements (`REQUIREMENTS_NOT_MET`).
- **roadmap:** reputation weighted by distinct verified companies, computed off-chain from events. The on-chain counters are the raw facts; the score is a view.

## 8. "Who pays rent, and does it ever come back?"

- **Cost:** about 0.0023 SOL (≈ $0.35) per Submission account, paid by our relayer.
- **done (v3.3):** rejected submissions are closed and the rent goes back to the payer (`rent_payer`). Accepted ones stay, for duplicate protection and reputation.
- **done (backend):** the relayer needs a session, has per-wallet rate limits and daily caps, and only creates token accounts for the configured mint.
- **Margins:** after rent, a $20–25 sourcing gig keeps about $1.65–2.15 of its $2.00–2.50 fee and a $40 screening about $3.65 of its $4.00. The margin is healthiest in calls (see `docs/strategy/market-and-business.md`).

## 9. "Walk me through the EU AI Act, GDPR and money transmission."

See `docs/legal.md`. In short:

- **AI Act:** candidate evaluation and allocating/evaluating gig work are high-risk uses (Annex III).
  - The agent scores; hiring decisions stay with the company.
  - Deliverable rejections are logged with reasons and visible to the company.
  - Before production we need a conformity process.
- **GDPR:**
  - Only hashes go on-chain.
  - Candidate data stays off-chain and is deleted on request.
  - The candidate confirms through a link (no client-asserted consent).
  - Processors (OpenRouter, Jev, Recall EU) need DPAs.
- **Money transmission:** funds sit in a program-owned vault, the company signs the caps and can revoke the agent. That non-custodial argument still needs legal review per market.

## 10. "What stops a recruiter from fabricating a screening?"

- **done (backend):** when a notetaker recording exists, the transcript comes only from the server-side Recall record. A pasted transcript is ignored, and the evidence hash is the hash of that record.
  - The agent checks the transcript: at least two speakers, a minimum duration, the candidate's name, coverage of the script.
  - Without a recording, the deliverable is marked self-reported and needs the candidate's confirmation.
- **done (v3.1):** the recruiter who sourced a candidate can't take that candidate's screening (`SelfReview`).
- **done:** self-reported calls are paid only after the candidate confirms the call via the sourcer's link; no-shows, a show-up fee and "report fake" are handled.
- **roadmap:** 5% spot-audits by a second screener.
- **Known limitation (unrecorded calls):** a self-reported screening call (no notetaker recording) is paid only after the candidate confirms the call happened, through a link sent to the candidate's *sourcer*, never to the recruiter claiming the call. Scout's keeper never auto-settles such a call, the backend's settle refuses it (`NOT_CONFIRMED`), and unanswered links expire just before the review window ends, so the agent rejects the deliverable. **The gap:** on-chain, `settle_expired` for call tasks is still permissionless after the review window. If Scout's agent is down past the window, anyone can settle an unconfirmed unrecorded call and the recruiter is paid by silence. Sourcing doesn't have this gap (settle needs the attestor or the company). Closing it needs the same attestor rule for call tasks in the program (roadmap).

## 11. "Your holdback is theatre."

- **done:** the default holdback window is 14 days; short windows exist only with `DEMO_FAST`.
- **done:** "Invite to interview" is no longer the release trigger. A separate "Came to the interview" action attests `Advanced`.
- **done (v3.3):** windows bounded on-chain (Config min/max), so nobody can set a 100-year holdback.
- **done:**
  - Fabricated refunds the holdback and flags the recruiter. Test: "holdback: Fabricated refunds the holdback to the company and flags the scout".
  - After the window anyone can release it. Test: "holdback: anyone releases it after the window; Fabricated is then too late".
  - Held funds are reserved. Test: "held-back funds are reserved: no new task can promise them, and close_role waits for them".

## Company in the loop (done)

- `roles.raiseGigPrice`: the agent closes a gig and reposts it at a higher price (agent-signed `close_task` + `create_task`, within the caps).
- `roles.loosenRequirement`: the company relaxes a criterion when the pipeline runs dry.
- `candidate.resendConfirmation`: re-sends the confirmation link.
- Live role status with sub-steps and slow/expected timing.

## 12. "AI sourcing tools find profiles for cents. Why pay a human $20–25 for a link?"

We don't pay for a link. Sourcing pays when the candidate confirms interest, which is the outreach work AI tools don't do. Even so, the real product is the call: screening, language and reference checks. Sourcing is a low-margin feeder.

## 13. "Who is the buyer, the startup or the agency? What stops them from going around you?"

- **Year 1:** our recruiting-agency design partner, whose freelance network already does this screening work on spec. Startups like Hanna come through agencies and operators first.
- **Disintermediation:** the screener sees a candidate and a company once. What keeps them is steady paid work across many roles and a portable reputation. The company keeps the agent, which runs the whole pipeline, not just one call.
- **Card on-ramp:** on the roadmap, so startups don't need USDC.

## 14. "Your numbers don't agree with each other."

They didn't. We now have one price sheet, `GIG_PRICES` in `backend/src/agent/gigs/market.ts` (CEE base prices; market and urgency multipliers on top):

| Gig | Price |
|---|---|
| Sourcing | $12 base × seniority (senior ≈ $20–25), paid on the candidate's confirmation |
| Screening | $40 |
| Tech screen | $100 |
| Language check | $15 |
| Reference check | $25 |

The fee is 10%, the operator takes 10% and the holdback is 30%. The projection is rebuilt bottom-up from a single agency's volume, with rent included (`docs/strategy/market-and-business.md`). Payouts in the demo script come from `math::split` (`docs/demo-script.md`).

## 15. "Why on-chain and not a database plus Wise or Deel?"

What holds after the fixes:

- **Permissionless settlement.** A company that goes silent can't stiff a recruiter for work the agent accepted into the pipeline. This survives the ghost-submission fix because the agent co-signs.
- **Funds sit in a program vault** with company-signed caps, not in our account.
- **Instant payouts to any country** without per-country payout rails.
- **Reputation and payment history** that the recruiter carries to any operator on the same program.

What doesn't hold: candidate data is off-chain, and the agent is ours. We say so.

## Attacks we tried on ourselves

| Attack | Defence | Status / test |
|---|---|---|
| **A. Ghost submissions, then settle on silence** | Agent co-sign on `submit_deliverable`; the indexer auto-rejects unknown submissions | done (v3.3 gatekeeper co-sign + indexer auto-reject; test: direct submit without the agent fails) |
| **B. Spoofed `x-wallet` header takes over the agent and reads PII** | SIWS sessions; company-only checks; spend tools removed from the autonomous agent; injection hardening | done |
| **C. LLM-fake candidates, then self-screening** | Candidate confirmation; ADVANCE-only pre-accept; bond for unvouched recruiters; `SelfReview`; clawback on Fabricated | v3.1 done ("bond: …", "separation of duties + reputation gate …"); confirmation link done |
| **D. Backend compromise drains everything** | Agent caps and `set_agent`; separate relayer, treasury and upgrade keys; upgrade authority off the server | done (v3.3); multisig on the roadmap |
| **E. Free reputation minting and relayer drain** | Minimum bounty and fee; rent reclaimed on reject; authenticated, rate-limited relayer | done (v3.3 + session-bound, rate-limited relayer with daily caps and mint-only ATAs) |

Already proven:

- **Exact money math.** `fee + operator_fee + held_back + payout == bounty` for every u64 input, with all rounding dust going to the recruiter. Tests: `math.rs` proptests (20k cases each) and "random bounties: the split sums exactly to the bounty and the invariants hold after every step".
- **Exactly-once settlement.** Test: "exactly once: a decided submission can't be accepted, rejected or settled again".
- **Payouts only to the right accounts.** Test: "payouts only reach the submitter's account, with the config mint and the configured treasury".
