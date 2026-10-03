# @scout/agent: run your own Scout agent

Scout is a protocol. A company's role is a budget on Solana (`RoleVault`), and whoever holds the key in `role_vault.agent` runs the role: posts paid gigs for recruiters, reviews what they deliver, and pays for good work. The hosted Scout agent is one implementation. This package is the same agent, so you can run it yourself with your own key and your own model (or no model at all). You can also run no agent and review by hand as the company.

The same code runs in the hosted backend (`backend/src/agent` is a symlink to `packages/agent/src`).

## What your agent can and can't do

- **It decides and signs.** The runner builds every money transaction itself from chain state and signs it with **your** key: `create_task`, `accept_submission`, `reject_submission`. The platform never signs as your agent, and the runner never signs a transaction the platform built for it.
- **It's the gatekeeper.** Recruiters' `claim_task` and `submit_deliverable` need `role.agent`'s co-signature. The runner checks each one before signing (`src/remote/cosign.ts`): only those two instructions, on your role, with your key in no other position, and the expected fee payer.
- **The chain caps it.** The company signed `agent_max_bounty` and `agent_max_commitment` when it created the role. A bug or a stolen key can't spend past them, and the company can replace the agent at any time with `set_agent`.
- **The platform is a helper, not a custodian.** It stores the off-chain parts (criteria, recruiter notes, the activity timeline), relays transactions so you don't need SOL (optional), and runs the candidate confirmation page.

## Quick start

```bash
# 1. A key for your agent (keep it on this machine; it holds no funds)
solana-keygen new -o ~/.config/scout/agent.json

# 2. The company points its role at that key (role creation, or set_agent later),
#    e.g. in the app: Role settings → Reviewer → "My own agent" → paste the public key.

# 3. Run it
pnpm --filter @scout/agent scout-agent \
  --role <RoleVault address> \
  --keypair ~/.config/scout/agent.json \
  --api https://api.scout.example/trpc
```

On start the runner checks on-chain that your key really is the role's agent, signs in with SIWS, and then runs a step every 30 s:
1. co-signs pending claims and deliveries;
2. settles sourced candidates who confirmed interest (`accept_submission`, signed by your key; the platform's confirmation attestor is only a backstop if your agent is offline past the review window);
3. runs one agent step: plan and post gigs, review new deliverables, accept / reject / escalate, book calls, build the shortlist.

## Options

| Flag | Default | |
|---|---|---|
| `--role` | required | The RoleVault address |
| `--keypair` | required | Your agent key (Solana JSON keypair) |
| `--api` | required | The platform's tRPC endpoint |
| `--rpc` | platform's | Your own RPC endpoint (recommended for production) |
| `--fee-payer` | `relayer` | `relayer`: the platform pays fees; `self`: your key pays (needs a little SOL) |
| `--interval` | `30` | Seconds between steps |
| `--once` | off | One step, then exit (for cron) |
| `--llm` | `offline` | `offline` (deterministic policy, no model calls), `openrouter`, `anthropic`, `openai` |
| `--model` / `--fast-model` | cheap defaults | Model ids for your provider |
| `--review` | `offline` | `jev` for per-criterion judgments with Jev (TypeSafe System One) |

Keys come from the environment or a `.env` file: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `JEV_API_KEY`.

**Offline is a complete agent.** Scores, budgets, prices and accept/reject are deterministic code in every mode. A model only writes briefs, scripts and summaries, and answers the company in chat. Offline mode uses templates for those.

## What the agent needs from the platform

The API is `agent.*` tRPC procedures (`packages/shared/src/agent-api.ts`, validated with zod on both sides), authenticated as your key via SIWS:

| Procedure | |
|---|---|
| `agent.config` | Chain deployment, relayer, confirmation attestor |
| `agent.roles`, `agent.role` | Roles where you are `role.agent`; the off-chain half of a role (criteria, gig metadata, candidates) |
| `agent.deliverables`, `agent.deliverable` | Recruiters' payloads (notes, call answers, transcripts) with the on-chain submission accounts |
| `agent.review.get/save`, `agent.sourcingReviews` | Your reviews (stored so the company can read them) |
| `agent.gig.register` | After your `create_task` confirms: title, brief and script (checked against `brief_hash`) |
| `agent.decision` | After your accept/reject confirms (or `pre_accept` for sourcing: the platform sends the candidate's confirmation link) |
| `agent.escalate`, `agent.askRecruiter`, `agent.criteria`, `agent.shortlist`, `agent.log`, `agent.decisionLog` | Talking to the company and recruiters, the timeline |
| `agent.cosign.list/submit/decline` | The gatekeeper queue |
| `tx.submit` | Relays a transaction you signed (the relayer adds the fee payer's signature) |

`src/remote/dev/memory-api.ts` is an in-memory reference implementation of this API. Use it as the spec and for local runs.

## Try it on a local chain

```bash
anchor build                     # once: target/deploy/scout.so
pnpm --filter @scout/agent exec tsx scripts/localnet-e2e.ts
```

This starts its own Surfpool on port 18899 (it doesn't touch your other validators), deploys the program, and creates a $750 role delegated to a fresh agent key. It then runs the runner against the reference API:
- the agent posts the sourcing gig (its own signature);
- it co-signs two deliveries;
- it rejects Piotr on-chain;
- it pre-accepts Karolina and, once she confirms, pays the sourcer with `accept_submission`;
- it books her screening call with the sourcer excluded on-chain.

## Security notes

- The agent key holds no funds and can move nothing outside its role's caps. Still, treat it like a production credential: one key per company, kept on the machine that runs the agent.
- Recruiter text (notes, answers, transcripts, names) is data, never instructions. It is wrapped as untrusted, injection attempts are flagged and stripped, and a flagged deliverable is never paid automatically.
- If the platform is unavailable, nothing is paid and nothing is lost. Deliverables you don't review in time are auto-accepted by `settle_expired` after the role's review window, which is the same rule as for a company that goes silent.
