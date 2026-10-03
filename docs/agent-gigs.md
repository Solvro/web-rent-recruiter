# Agent-run hiring with human gigs (v2 product spec)

The company hires the **agent**, not recruiters. The agent runs the role end to end and rents humans for the parts it can't do. Recruiters don't "drop candidates and magically get paid": they claim **gigs** with a clear deliverable, the agent checks the work, and payment is instant.

## Flow

1. **Hanna gives the agent a role and a budget.** She pastes the JD and funds e.g. $750 (the demo budget). The budget sits in the RoleVault. The **agent's wallet is `role.agent`**: it can create gigs and accept deliverables, capped on-chain by the vault.
2. **The agent plans and posts gigs** from the budget:
   - `SOURCING`: "Find up to 20 senior Rust / Solana engineers in Warsaw", $25 per profile the agent accepts and the candidate confirms (base $12 × seniority, rare profile). One deliverable = one candidate (profile link + 2-line note). Duplicate protection as today.
   - `SCREENING_CALL`: "30-min call with Karolina Mazurek", $40. Posted by the agent only for candidates it scored ADVANCE. It comes with a **question script** written by the agent from the criteria. Deliverable = answers to each script question + a recommendation (+ optional transcript). Paid for **quality of answers, not minutes**.
   - `REFERENCE_CHECK`: "Reference call for Karolina", $25, posted for the finalist. Deliverable = structured answers.
   - (`CULTURE_FIT` later.)
3. **Recruiters claim a gig** on the board (one claimer for screening and reference gigs, many for sourcing) and deliver.
4. **The agent reviews every deliverable:**
   - It scores sourced candidates against the criteria.
   - It checks screening and reference notes against the script (every question answered, concrete evidence, consistent with the profile).
   - It **accepts** (it signs as `role.agent`, so the recruiter is paid instantly), **rejects** with a reason, or escalates to Hanna when unsure.
   - Holdback and operators work as now.
5. **Hanna sees the agent working** (activity timeline + budget) and receives a **shortlist**: screened candidates with call notes and reference checks. She makes the final human decision ("Invite to interview" / "Pass"). "Invite to interview" attests `Advanced` and releases holdbacks.
6. **Reputation** accrues per gig type on-chain. A task can require N accepted sourcing deliverables before it can be claimed (`Task.min_accepted`, program v3.1); unvouched recruiters post a bond (`Task.bond_bps`); the sourcer of a candidate can't take that candidate's screening (`Task.subject_scout`).

## On-chain changes (Stream A)

- `Task` PDA `["task", role_vault, task_id u32]`:
  - fields: `role_vault`, `task_id`, `task_type`, `bounty`, `max_deliverables: u16`, `accepted_count`, `pending_count`, `claimant: Option<Pubkey>` (exclusive gigs), `brief_hash [u8;32]` (hash of the brief / question script), `status Open|Closed`, `holdback_bps`, `bump`;
  - bounty, holdback and caps move from RoleVault to Task. RoleVault keeps the budget, the counters, `agent`, `fee_bps` and `company`.
- `create_task(task_id, task_type, bounty, max_deliverables, exclusive, brief_hash, holdback_bps)`: signed by the company **or** `role.agent`.
  - **Role-level funded invariant:** `vault balance ≥ Σ over open tasks (pending × bounty) + held_back_total`, checked when a deliverable is submitted (as today).
  - A soft cap `Σ open-task (max_deliverables − accepted) × bounty ≤ balance` is checked at create.
- `claim_task()`: scout signs; only for exclusive gigs, and the claimant must be None. `release_claim()`: the claimant, or the company/agent after a timeout.
- `submit_deliverable(deliverable_hash, evidence_hash)`: Submission PDA `["submission", task, deliverable_hash]` (was role_vault). For exclusive gigs only the claimant can submit.
- accept / reject / settle_expired / attest_outcome / release_holdback operate on the Submission + its Task. Accept and reject are signed by company **or** `role.agent`. Silence still means acceptance, but only for deliverables the gatekeeper (agent or company) co-signed at submit (v3.3, live), so direct on-chain spam can't be settled.
- `close_task()` (company/agent) and `close_role()` (company; all tasks closed, nothing pending/held).
- ScoutProfile: per-type counters `sourcing_accepted`, `screening_accepted`, `reference_accepted` (plus the existing totals).

## Off-chain (Streams B and C)

- **Agent wallet:** a backend keypair (`AGENT_KEYPAIR`), set as `role.agent` at create_role. The relayer still pays fees.
- **Agent orchestrator loop** (backend service). On role funded it:
  1. plans gigs (C: `planGigs(role, budget)` returns the list with prices and briefs);
  2. posts SOURCING;
  3. scores each sourced candidate. If above the threshold it auto-accepts and, for the top N, posts a SCREENING_CALL with a script (C: `screeningScript(criteria, candidate)`);
  4. reviews the screening notes (C: `reviewScreening(script, notes)` returns pass/fail with reasons) and accepts;
  5. posts REFERENCE_CHECK for the finalist(s), reviews and accepts;
  6. builds the shortlist (C: `shortlist(role)`).

  Every step is logged to `agent_activity` and pushed over the events subscription.
- **tRPC:**
  - `gigs.list`, `gigs.byId`, `gigs.claim`, `gigs.deliver`, `gigs.mine` (recruiter);
  - `roles.activity`, `roles.shortlist`, `roles.decide` (company: invite / pass);
  - existing procedures adapted.
- **Demo knobs:** short windows, a seeded believable agent run, and a "run agent step now" debug action (hidden).

## UI (Stream D, all existing rules apply)

- **Company role page:** the hero is **the agent**: a status line ("Your agent is screening 3 candidates"), budget left, then a quiet activity timeline ("Posted: find 20 engineers · $5 each", "Accepted 6 profiles", "Booked a screening for Karolina", "Reference check passed"). The shortlist cards (avatar, score, screening summary, reference summary) carry "Invite to interview" / "Pass".
- **Recruiter gig board:** each gig card shows type, short brief, what you earn, slots / "1 recruiter". Actions: Claim, then Deliver.
  - The delivery form depends on the type: candidate link + note; script questions with an answer field each; reference questions.
  - After delivery: "The agent is checking your work" leads to the payout moment.
- **Copy:** "your agent" for companies, "gigs" for recruiters. No crypto words.

## Not now (roadmap)

A Google Meet bot that joins screening calls and checks the transcript against the script; culture-fit gigs; other agents posting gigs through the open protocol / MCP.
