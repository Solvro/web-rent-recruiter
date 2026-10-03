# HackTribe submission

**Title:** Scout: an AI recruiting agent that hires people for gigs and pays them on Solana

**Team:** Solvro Londyn

**Description**

Scout is a protocol: an on-chain program plus an open agent API. Our hosted agent and web app are one implementation of it. The program enforces the money rules. A reviewer the company chooses (our agent, its own agent or the company itself) decides what is accepted.

Scout lets a company give an AI agent a role and a budget. The budget goes into a vault owned by a Solana program; the company signs once and sets the agent's spending caps. The agent breaks hiring into small paid gigs that need a human: finding candidates, a 30-minute screening call recorded by a notetaker, a language check, a reference check. Independent recruiters anywhere claim gigs and deliver. The agent checks each deliverable and, in the same on-chain transaction, the program pays the recruiter, the operator who vouches for them and the platform fee.

- 30% of the recruiter's share waits until the candidate actually reaches the company.
- If the company goes silent, anyone can trigger the payout after the review window.
- Unused budget goes back to the company.
- The company can replace our agent at any time.

In the demo a startup funds a $750 budget of verified work, compared with an agency fee of ~20% of an annual salary (public benchmark). Our design partner is a recruiting agency whose freelance network already runs screening calls on spec, rewarded only by a success fee if the candidate is hired.

**Design rationale (summary)**
- **Relationship:** a company paying independent recruiters for pieces of hiring work.
- **The intermediary was** the agency or platform that held the money and decided who got paid and when. For screeners that meant a success-fee lottery: most screening calls are never paid.
- **Now** the vault, the payout split, the holdback, bonds, separation of duties, permissionless settlement and refunds are enforced by the program. Judgement belongs to a reviewer the company picks and can replace (`set_agent`), not to us. Full text: `docs/design-rationale.md`.

**Target users**
1. Independent recruiters and screeners outside crypto, mostly CEE freelancers.
2. Startups hiring their first engineers.

The chain is hidden on purpose: Google login, dollars, "Payment sent", and a small "Proof of payment" link to the transaction.

**Links**
- Deck (PDF, ≤ 10 slides): `[link]`
- Video (≤ 3 min): `[link]`
- Repository: `[https://github.com/Rei-x/scout-hackyeah]` (to be made public)
- Live demo: `[link]`
- Program on devnet: `CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2`

## Compliance checklist

| Rule | Evidence | Status |
|---|---|---|
| Runs on Solana (devnet is enough) | Program `CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2`, `deployments/devnet.json` | ✅ (v3.3, [upgrade tx](https://solscan.io/tx/Jbbm8wdm9xixPncFTcbqcVceffA8vwioPRPW2pZtydeHkg7e9A8UcPA5HvFpN5ruDEpPVCQjKwC5DiGLCcr7eMq?cluster=devnet)) |
| A working app, not a mockup | `app/` + `backend/`, live on devnet through the Helius RPC | ✅ |
| One full use case from input to completed transaction | Gig flow e2e on devnet (`pnpm e2e`): create_role → create_task (agent) → submit → accept → attest Advanced; tx links in the Stream A report | ✅ (UI on v3.2 ⏳) |
| Show the moment the intermediary is no longer needed | Accept → payout in one tx; `settle_expired` with no signer; Solscan link in the app ("Proof of payment") | ✅ |
| Works live during the presentation | `docs/demo-script.md`, `DEMO_FAST`, `RECALL_MOCK`, `?data=mock` fallback | ⏳ (rehearsal) |
| Logic replacing the intermediary lives on-chain | `programs/scout/src/instructions/*`, `math.rs`, `invariants.rs`; README "Scout is a protocol" and "Did the backend become the intermediary?" | ✅ (gatekeeper = agent or company, v3.3; self-hosted `scout-agent` CLI) |
| Target user named explicitly | `docs/design-rationale.md` "Who we build for" | ✅ |
| Design rationale | `docs/design-rationale.md` | ✅ |
| Title + detailed description | This file | ✅ |
| PDF presentation, max 10 slides | Deck artifact, PDF export | ⏳ |
| Public video ≤ 3 min | — | ⏳ |
| Public code repository | Private for now: `github.com/Rei-x/scout-hackyeah` | ⏳ |
| Clear README | `README.md` | ✅ |
| Answers to the judges' questions | README "The judges' five questions", `docs/jury-qa.md` | ✅ |
| Program tests | `tests/scout.ts`, `math.rs` proptests | ✅ |

## Data hygiene

The design partner's internal data (volumes, payout schedules, code, internal channels) is not in this repo. It is only mentioned live in the pitch. Demo roles, companies, people and URLs are fictional.
