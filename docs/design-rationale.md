# Design rationale

## The financial relationship we redesigned

**A company paying independent recruiters for pieces of hiring work:** finding candidates, a 30-minute screening call, a language check, a reference check.

## Who the intermediary was

The agency or recruiting platform. It:

- **holds the client's money**;
- **decides who gets paid, how much and when**;
- **pays on its own schedule.**

For screeners, that schedule is often a lottery: freelance screeners are typically paid only through a share of the success fee if the candidate is hired, months later, so most calls are never paid (our hypothesis, based on our recruiting-agency design partner). Elsewhere, invoices take 30–90 days and payments to other countries need a payments provider per region.

Both sides have to trust the intermediary:

- The recruiter trusts it to pay for work that was used.
- The company trusts it to pay only for work that was done.

## What changes on-chain

| Before (trusted intermediary) | After (`programs/scout`) |
|---|---|
| The platform holds the budget | The budget sits in a vault owned by a program PDA (`create_role`). We can't move it outside the program's rules. |
| The platform decides when someone is paid | Payment happens in the same transaction as the acceptance (`accept_submission` → `payout::pay_out` → `math::split`). The split is exact: fee + operator + held back + payout = bounty, for every input. |
| A silent client means an unpaid recruiter | `settle_expired` is permissionless: after the review window anyone can trigger the payout. |
| The platform can quietly spend the client's money | The company signs the agent's caps (`agent_max_bounty`, `agent_max_commitment`, enforced in `create_task`) and can revoke or replace the agent at any time (`set_agent`). |
| Quality is the platform's promise | Quality is enforced by money: 30% of the recruiter's share is held back until the candidate reaches the company (`attest_outcome` / `release_holdback`). Unvouched recruiters post a bond the company keeps if the work is rejected. The person who sourced a candidate can't screen them (`SelfReview`). |
| Reputation lives in the platform's database | Per-gig-type counters live in the recruiter's on-chain `ScoutProfile`, readable by any operator. |
| Leftover budget is stuck with the platform | `close_role` refunds everything left to the company. |

**Scout is a protocol, not a platform.** The program enforces money and payout rules for anyone. Judgement (accept or reject) is done by a reviewer the company chooses: our hosted agent (default), its own self-hosted agent (`scout-agent` CLI, `packages/agent`) or the company itself. The gatekeeper can be the agent or the company (v3.3, live on devnet), and the company switches with `set_agent`. Reviews and rejection reasons are hashed on-chain, and appeals are live: the recruiter appeals a rejection (`submissions.appeal`), the company decides (`decideAppeal`), and an overturn pays the recruiter directly.

Our own hosted pieces are one implementation:

- the AI agent, which the company names as its delegate and can replace;
- the candidate database;
- a relayer that pays network fees so users never need SOL.

None of these can take custody of funds.

## Who we build for

1. **Independent recruiters and screeners outside the crypto world.** Mostly CEE freelancers who work for foreign clients and wait months to be paid, or are never paid. They log in with Google and see dollars and "Payment sent". They never see a wallet, a seed phrase or SOL.
2. **Startups hiring their first engineers** (in the demo, Hanna, the founder of a seed-stage Solana startup). They paste a job description, fund a budget once, and get a shortlist.

Hiding the chain is a deliberate choice. Neither user would adopt a product that asks them to manage keys or tokens. A small "Receipt → Proof of payment" link after each payment shows the real transaction to anyone who wants to check it.

## Honest limits

- **Our hosted agent decides within the company's caps** which deliverables meet the bar. It is the default reviewer, not a required one: the company can run its own or review itself (`set_agent`).
- **If our hosted service goes down**, that is a loss of service, not of custody. Funds stay in the vault. Screening, language and reference work settles permissionlessly; a sourcing payout waits for its confirmation attestor or the company (the trade-off of paying only on the candidate's confirmation). The company can switch reviewer or close the role.
- **We hold the upgrade authority on devnet** (a cold key). It is our real power. A multisig and later immutability are on the roadmap.
- **Candidate data is off-chain;** only hashes are stored on-chain.

See `docs/security.md`, `docs/jury-qa.md` and `docs/legal.md`.
