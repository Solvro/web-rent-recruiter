# Scout

**A company gives an AI recruiting agent a budget. The agent turns the role into clear criteria and posts small paid tasks for independent human recruiters ("scouts"). Every accepted candidate is paid out instantly in USDC by a Solana program, and each scout builds a portable on-chain reputation.**

Built for HackYeah 2026, Superteam Poland challenge "Finance Without Intermediaries". The program is live on Solana devnet.

> The product name lives in one constant, `PROJECT_NAME` in `packages/shared/src/constants.ts`.

## The problem

- AI can process profiles, but it cannot replace a human for sourcing hard-to-reach people, doing outreach or running first conversations.
- Companies choose between agencies (about 20% of annual salary, paid only on hire) and doing it all themselves.
- Independent recruiters around the world wait weeks or months to get paid and carry the risk of never being paid.
- **Our model:** pay per accepted unit of work, one qualified and interested candidate at a time. Start with a small budget and top up as trust grows.

Full reasoning: [docs/design-rationale.md](docs/design-rationale.md). Live demo: [docs/demo-script.md](docs/demo-script.md).

## Where exactly does the intermediary disappear?

The role budget sits in a token account owned by a program PDA (`RoleVault`), never by us. Funds leave it only through the program's rules:

- [`accept_submission`](programs/scout/src/instructions/accept_submission.rs): the company, or its delegated agent, accepts a candidate. One transaction pays the scout `bounty − fee` and the treasury `fee` ([`payout.rs`](programs/scout/src/instructions/payout.rs)).
- [`settle_expired`](programs/scout/src/instructions/settle_expired.rs) is **permissionless**. If the company doesn't decide before `review_deadline`, anyone can trigger the payout. Silence counts as acceptance.
- [`submit_candidate`](programs/scout/src/instructions/submit_candidate.rs) only accepts a submission if the vault can pay for every pending one. A submitted candidate is always fully funded.
- [`close_role`](programs/scout/src/instructions/close_role.rs) refunds the unspent budget to the company, and only when nothing is pending.

Our backend never holds funds. It relays transactions and pays network fees so users never need SOL. It adds its fee-payer signature only to transactions the user already signed, and rejects any instruction outside an allowlist ([`backend/src/solana`](backend/src/solana)).

## What if one party disappears?

| Who goes silent | What happens |
|---|---|
| The company stops reviewing | After the review window, `settle_expired` pays the scout. Anyone can call it, and the UI shows the scout a "Claim payout" button. |
| The scout disappears | Nothing is owed. Their submission is either reviewed or settles after the window. |
| The company wants out | `close_role` returns the unspent budget once pending submissions are resolved. |
| We (the platform) disappear | Funds stay in the program. The company can still close and refund, and scouts can still settle, directly against the program without our backend. |

## Who can do what?

| Instruction | Who signs | Rule |
|---|---|---|
| `initialize_config` | admin | Sets the fee (bps), treasury and USDC mint. Runs once. |
| `create_role` | company | Funds the vault and snapshots the fee into the role. |
| `top_up` | company | Role must be open. |
| `register_scout` | scout | Creates the reputation account and USDC account. |
| `submit_candidate` | scout | Role open, slots left, and the vault covers every pending submission. |
| `accept_submission` | company or delegated `agent` | Pending only. |
| `reject_submission` | company | Pending only, and only before the deadline. |
| `settle_expired` | **anyone** | Pending and the deadline has passed. |
| `close_role` | company | No pending submissions. Refunds the vault. |

Every instruction also takes a separate `payer` (our relayer) that pays fees and rent and holds no authority.

**Upgrade authority:** the program is upgradeable by the deployer key during the hackathon. The fee is snapshotted per role, so a fee change never affects a running role. Before handling real money the upgrade authority moves to a multisig, and later the program becomes immutable.

## Why blockchain and not a database?

- **No custodian:** the budget sits in a program, not with us. We can't freeze it, delay a payout or run off with it.
- **Instant global payouts:** a scout in any country receives USDC seconds after acceptance, with no invoices or payment provider.
- **Portable reputation:** `ScoutProfile` (submitted / accepted / rejected / total earned) is public and belongs to the scout, not to our marketplace.
- **Provable first submission:** the Submission PDA is seeded by `[roleVault, sha256(roleSalt + profileUrl)]`. The same candidate can't be submitted twice for a role, and the chain's timestamp shows who was first. No personal data goes on-chain.

## AI with a human in the loop

The agent ([`backend/src/agent`](backend/src/agent)):
- drafts weighted criteria from a job description;
- suggests a bounty with a deterministic heuristic, with an LLM writing the rationale;
- scores every submission per criterion, quoting the scout's notes as evidence.

Verdicts come from [Jev](https://docs.typesafe.ai) (TypeSafe System One) through OpenRouter, in about 1 s for about $0.001 per review, with an LLM and offline heuristics as fallbacks. The score itself is computed by code, so it is explainable and consistent.

A person always makes the final decision. Under the EU AI Act, AI used to evaluate candidates in recruitment is high-risk and requires meaningful human oversight. The optional auto-accept by the delegated agent is capped on-chain at the bounty and the vault balance.

## Repository layout

| Path | What |
|---|---|
| `programs/scout/` | Anchor 1.1 program: accounts, 9 instructions, events |
| `tests/scout.ts` | Program tests on Surfpool (`anchor test`) |
| `packages/shared/` | Shared types, zod API contract, constants, generated program client (`@scout/shared/program`) |
| `backend/` | Fastify API, Drizzle and Postgres, relayer, event indexer (SSE), AI agent module |
| `app/` | React + Vite, shadcn/ui (Base UI), TanStack Router and Query, Privy login |
| `scripts/` | Mock USDC mint and config setup, wallet funding, demo reset, CLI end-to-end |
| `docs/` | [Program interface](docs/program-interface.md), [design rationale](docs/design-rationale.md), [demo script](docs/demo-script.md) |

## Run it

Prerequisites: Node 24, pnpm, the Rust, Solana CLI, Anchor 1.1 and Surfpool toolchain (`curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash`), and Docker (optional; without it the backend uses embedded PGlite).

```bash
pnpm install
cp backend/.env.example backend/.env    # OPENROUTER_API_KEY optional, the agent falls back to offline
cp app/.env.example app/.env            # VITE_PRIVY_APP_ID or demo-mode keys

pnpm db:up && pnpm seed                 # Postgres on :5433 + demo data
pnpm dev                                # API on :8788, app on http://localhost:5173
```

Program and chain:

```bash
pnpm build                      # anchor build + regenerate the TS client
anchor test                     # program tests on a local Surfpool
pnpm setup:devnet               # mock USDC mint + Config, writes deployments/devnet.json
CLUSTER=devnet pnpm e2e         # CLI end-to-end: create role, submit, accept (+18 USDC to the scout)
CLUSTER=devnet pnpm reset:demo  # before a demo: fresh scout wallets, company back to 1000 USDC
pnpm --filter @scout/backend agent demo   # agent on sample job descriptions and candidates
```

## Devnet deployment

| | Address |
|---|---|
| Program | [`CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2`](https://explorer.solana.com/address/CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2?cluster=devnet) |
| Mock USDC mint (6 decimals) | `2bK9qWsavQ7KYRPgaurwkfcaVAQkDFx4UA3dd7fVi7vm` |
| Config | `GWMroNwxZ8CwitvSau8ioJx3c7uVm5LJVGYkj6u7YTKW` |
| Relayer and treasury | `8VJdBDpp55sENHDpQjJaGdWXBFQwnZ28KZ6cf5SQBv1f` |

Demo wallets (devnet only, keys in `~/.config/solana/superrecruiter/`, never committed):

| Role | Keypair | Address |
|---|---|---|
| Company | `client.json` | `2XtdaRgpB4W9PXRQZRuPYiM67iH8fVq9bhwZ6nhAdv3v` |
| Scout | `recruiter.json` | `7LAJf9thHU6pJetTZRC6fEkkVFkYNLvbBg3Q4BxPzoES` |
| Second scout | `scout2.json` | `7T22uqJFDo4DVchFPDcbNQUp3K2j1Ne7GkH7NeAHdQ6L` |

The scout keypairs rotate on every `reset:demo`. Back up the program keypair `target/deploy/scout-keypair.json` (git-ignored); without it the program can't be upgraded at the same address.

## What we would do next week

- **Screening-call tasks:** pay per completed first call with structured notes. `taskType` already exists.
- **ATS webhook integration:** a hire bonus paid from the same vault when the candidate signs.
- **Fiat on-ramp** for companies paying by card, and a signed sign-in for the API.
- **Two-sided reputation:** company rejection rates visible to scouts.
- **Open protocol:** an MCP server so any AI agent can post recruiting tasks.
