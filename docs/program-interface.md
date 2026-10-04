# RentRecruiter program interface (contract)

Agreed interface between the Anchor program (`programs/scout`) and its clients. The IDL generated from the program is the source of truth once it exists. Until then, build against this file. Changing anything here means updating every stream.

- Anchor 1.1.x, Token Interface (classic SPL Token mint, 6 decimals, labelled USDC).
- Amounts are `u64` base units. Timestamps are `i64` unix seconds from `Clock`.
- **Every instruction has a separate `payer: Signer (mut)`.** The backend relayer pays fees and rent, and users only sign as authorities. `payer` may equal the authority.
- Vault token account = associated token account of the RoleVault PDA (`allowOwnerOffCurve`).

## Model (v3.3, agent gigs, protocol-first)

The company funds a **RoleVault** once and delegates it to the AI agent (`role.agent`) within company-signed limits. The agent posts **Tasks** (gigs) against that budget, recruiters ("scouts") deliver **Submissions**, and the agent accepts or rejects them. See [agent-gigs.md](agent-gigs.md) and, for the threat model, [security.md](security.md).

Rules:
- Every deliverable belongs to an Open Task.
- On exclusive tasks only the claimant can deliver.
- Deliverables and claims need a **gatekeeper** co-signature: `role.agent` **or** the company, always. Nothing depends on our agent: the company (or a self-hosted agent set via `set_agent`) can run every step itself.
- Reviews are verifiable: `accept_submission(review_hash)` stores and emits the hash of the review, and `reject_submission(reason_code, reason_hash)` emits the hash of the reason the recruiter was shown.

Signers per instruction: **C** = company, **A** = `role.agent`, **C/A** = either, **G** = gatekeeper (= C/A), **S** = scout, **O** = operator authority, **Adm** = Config admin (the program upgrade authority), **any** = no signer besides the payer.

## Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `["config_v2"]` | admin, treasury (wallet), treasury_token_account, fee_bps: u16 (≤ 2000), usdc_mint, min_bounty: u64, min_reputable_bounty: u64, min_window_seconds: i64, max_window_seconds: i64, bump |
| `RoleVault` | `["role", company, role_id u64 LE]` | company, role_id, mint, vault_token_account, agent: Option<Pubkey>; snapshots `fee_bps`, `min_bounty`, `min_reputable_bounty`; `agent_max_bounty`, `agent_max_commitment`, `agent_committed` (u64); review / claim-timeout / holdback windows (i64); task_count, open_task_count, accepted_count, pending_count (u32); `pending_value`, `open_capacity`, `held_back_total`, `bonds_held`, `total_deposited`, `total_paid` (u64); status {Open, Closed}; bump. 277 bytes. |
| `Task` | `["task", role_vault, task_id u32 LE]` | role_vault, task_id, task_type {Sourcing, ScreeningCall, ReferenceCheck}, bounty, max_deliverables, accepted_count, pending_count (u16), exclusive, claimant: Option<Pubkey>, claimed_at, brief_hash [u8;32], holdback_bps (≤ 5000), subject_scout: Option<Pubkey>, min_accepted: u16, min_accept_rate_bps: u16, created_by_agent: bool, reputable: bool, bond_bps (≤ 2000), status, bump, confirmation_attestor: Option<Pubkey> (SOURCING settle; `None` = current `role.agent`) |
| `Submission` | `["submission", task, deliverable_hash]` | role_vault, task, scout, deliverable_hash, evidence_hash, submitted_at, review_deadline, status {Pending, Accepted, Rejected}, reject_reason (255 = none), holdback_amount, rent_payer, bond_amount, holdback_deadline, outcome {None, Advanced, Fabricated}, review_hash [u8;32], bump. **Closed on reject**, with rent back to `rent_payer`. Accepted ones stay as the dedupe and reputation record. |
| `ScoutProfile` | `["scout", scout]` | scout, submitted, accepted, rejected, sourcing_accepted, screening_accepted, reference_accepted, advanced, flagged (u32), total_earned, operator: Option<Pubkey>, bump. The reputation counters only move on `reputable` tasks. `flagged` and `total_earned` always move. |
| `Operator` | `["operator", authority]` | authority, name (≤ 32 B), fee_bps (≤ 2000), token_account, recruiters, accepted, advanced, flagged, bump |

### Budget invariants (asserted on-chain, see `programs/scout/src/invariants.rs`)

With `V` = vault token balance:
- **I1** `V ≥ pending_value + held_back_total + bonds_held`: every pending deliverable is funded; holdbacks and bonds are still in the vault.
- **I2** `open_capacity ≤ V − held_back_total − bonds_held`: open tasks never promise more than the free budget. `create_task` fails with `OverCommitted`.
- **I3** `pending_value ≤ open_capacity`.
- **I4** per task: `accepted + pending ≤ max_deliverables` (`TaskFull`).
- **Agent cap:** an agent-created task needs `bounty ≤ agent_max_bounty` and `agent_committed + max × bounty ≤ agent_max_commitment` (`AgentCapExceeded`). Closing a task returns its unused slots to the allowance.
- **close_role:** `open_task_count == 0`, `pending_count == 0`, `held_back_total == 0`. It sweeps the vault and closes the vault token account.

## Money flow per accepted deliverable (`programs/scout/src/math.rs`)

The company pays exactly `task.bounty`. Every percentage is floored, and the scout gets the remainder, so all rounding dust goes to the scout:

```
fee           = floor(bounty × role.fee_bps / 10000)             -> treasury, now
operator_fee  = floor((bounty − fee) × operator.fee_bps / 10000) -> operator, now (0 without one)
share         = bounty − fee − operator_fee
holdback      = floor(share × task.holdback_bps / 10000)         -> vault (held_back_total)
payout        = share − holdback                                 -> scout, now
fee + operator_fee + holdback + payout == bounty                 (proptest, every u64 input)
```

**Bond** (scouts without an operator, when `task.bond_bps > 0`): `floor(bounty × bond_bps / 10000)` moves from the scout to the vault at submit (`bonds_held`). It is returned whole on accept or settle, and on reject it becomes company budget (`total_deposited += bond`). It is never part of the split.

**Holdback**:
- `attest_outcome(Advanced)` releases it to the scout.
- `attest_outcome(Fabricated)`, only while `now ≤ holdback_deadline`, refunds it to the company and flags the scout and operator.
- `release_holdback()` after the deadline can be called by anyone and pays the scout.

## Instructions

| # | Instruction | Args | Signers | Effect |
|---|---|---|---|---|
| 1 | `initialize_config` | treasury: Pubkey, params: ConfigParams { fee_bps, min_bounty, min_reputable_bounty, min_window_seconds, max_window_seconds } | payer, Adm (must be the program's upgrade authority, read from ProgramData) | Creates the Config and the treasury ATA. `InvalidConfig` unless fee ≤ 2000, min_bounty > 0, min_reputable ≥ min_bounty, and 1 s ≤ min ≤ max ≤ 365 d. |
| 2 | `update_config` | params | payer, Adm | Rotates the treasury (account `treasury_wallet`, ATA init_if_needed) and changes fee and bounds. The mint and admin are fixed. Open roles keep their snapshots. |
| 3 | `create_role` | role_id, agent: Option<Pubkey>, review_window_seconds, claim_timeout_seconds, holdback_window_seconds, initial_deposit, agent_max_bounty, agent_max_commitment | payer, C | Windows must be within the Config bounds (`WindowOutOfRange`). Snapshots fee, min_bounty and min_reputable_bounty. |
| 4 | `set_agent` | agent: Option<Pubkey>, agent_max_bounty, agent_max_commitment | payer, C | Rotates or revokes (`None`) the agent and changes its limits. |
| 5 | `top_up` | amount | payer, C | Company ATA → vault. |
| 6 | `create_task` | task_id (= role.task_count), task_type, bounty (≥ role.min_bounty), max_deliverables, exclusive, brief_hash, holdback_bps, subject_scout, min_accepted, min_accept_rate_bps (≤ 10000), bond_bps, confirmation_attestor: Option<Pubkey> | payer, C/A | Checks I2 and the agent cap (when the signer is the agent). Sets `reputable = bounty ≥ min_reputable_bounty`. |
| 7 | `claim_task` | none | payer, S, **G** | Exclusive tasks only. The claimant must be None. RentRecruiter ≠ subject_scout (`SelfReview`). The reputation gate must pass (`ReputationTooLow`): `sourcing_accepted ≥ min_accepted`, and when `min_accept_rate_bps > 0`, `submitted > 0` with `accepted / submitted ≥ rate`. |
| 8 | `release_claim` | none | payer, claimant or C/A | The company or agent only after `claim_timeout` and with nothing pending. |
| 9 | `close_task` | none | payer, C/A | Pending must be 0. Frees capacity and returns unused agent allowance. |
| 10 | `register_operator` | fee_bps (≤ 2000), name | payer, O | |
| 11 | `register_scout` | none | payer, S (+ O to vouch) | |
| 12 | `submit_deliverable` | deliverable_hash, evidence_hash | payer, S, **G** | Accounts add `gatekeeper`, `scout_token_account` (owner = scout, mint = role mint), `mint`, `token_program`. The scout can't be the company or the agent (`SelfDealing`). Exclusive tasks require the claimant. Applies the same SelfReview and reputation gates. Non-sourcing tasks need an evidence hash. Posts the bond when applicable. Checks I1–I4. Stores `rent_payer = payer`. |
| 13 | `accept_submission` | review_hash [u8;32] (zeroes allowed) | payer, C/A | Pays the split and returns the bond. Reputation counters move only if `task.reputable`. |
| 14 | `reject_submission` | reason_code 0..=3, reason_hash [u8;32] (emitted in `SubmissionRejected`) | payer, C/A | Only while `now ≤ review_deadline`. Forfeits the bond to the budget. Clears the exclusive claim if the rejected scout held it. **Closes the Submission** (account `rent_payer` must equal `submission.rent_payer`). |
| 15 | `settle_expired` | none | payer; SOURCING also `attestor` | Pending and past the review deadline: same as accept (review_hash = 0). **Non-sourcing tasks: anyone can settle.** SOURCING tasks: the optional `attestor` signer must be `task.confirmation_attestor` (or the current `role.agent` if that's `None`) or the company (`NotAttestor`), because a sourced candidate only counts once confirmed off-chain. |
| 16 | `attest_outcome` | outcome, reason_code | payer, C/A | See Holdback above. |
| 17 | `release_holdback` | none | payer (any) | |
| 18 | `close_role` | none | payer, C | See the invariants above. |

Optional accounts (`operator`, `operator_token_account`, `operator_authority`) are omitted by passing the program ID. The Codama client does this when you leave them `undefined`.

Errors: InvalidFee, InvalidRoleParams, InvalidTaskParams, InvalidTaskId, InvalidAmount, RoleClosed, TaskClosed, TaskFull, OverCommitted, InsufficientBudget, NotPending, Unauthorized, ReviewWindowOpen, ReviewWindowExpired, InvalidReason, PendingSubmissions, OpenTasks, InvalidTokenAccount, MissingEvidence, NotExclusive, AlreadyClaimed, NotClaimant, NotClaimed, ClaimTimeoutOpen, InvalidHoldback, NotAccepted, OutcomeAlreadySet, InvalidOutcome, HoldbackWindowExpired, HoldbackWindowOpen, NothingHeldBack, HoldbackOutstanding, InvalidOperatorFee, InvalidOperatorName, OperatorSignatureRequired, OperatorMismatch, SelfDealing, NotUpgradeAuthority, ReputationTooLow, SelfReview, InvalidBond, BountyTooSmall, WindowOutOfRange, InvalidConfig, AgentCapExceeded, NotGatekeeper, NotAttestor, InvariantViolated, Overflow.

## Events

`RoleCreated`, `RoleToppedUp`, `AgentUpdated {role_vault, agent, agent_max_bounty, agent_max_commitment}`, `ConfigUpdated`, `TaskCreated {…, subject_scout, min_accepted, min_accept_rate_bps, bond_bps, confirmation_attestor, created_by}`, `TaskClaimed`, `ClaimReleased`, `TaskClosed`, `OperatorRegistered`, `ScoutRegistered`, `DeliverableSubmitted {…, bond, review_deadline}`, `SubmissionAccepted {…, payout, fee, operator, operator_fee, held_back, holdback_deadline, bond_refunded, auto_settled, accepted_by, review_hash}`, `SubmissionRejected {…, reason_code, reason_hash, rejected_by}`, `BondForfeited`, `OutcomeAttested`, `HoldbackReleased`, `RoleClosed`. The exact field lists are in the IDL (`target/idl/scout.json`).

## Off-chain conventions

- Sourcing `deliverable_hash = sha256(role_salt + normalize(profileUrl))` (formerly `candidate_hash`). Duplicate protection is per task: the same candidate on two different sourcing tasks of one role is not blocked on-chain. Screening and reference deliverables: any unique hash (e.g. sha256 of task + candidate), with `evidence_hash = sha256(notes JSON)`. `role_salt` is 16 random bytes (hex) per role and is stored in Postgres only. `normalize` lowercases the URL and strips the protocol, `www.`, the query string, the hash and a trailing slash.
- `role_id` is assigned by the backend as a u64 (a DB sequence). `task_id` must be read from `role.task_count` right before `create_task`, so create tasks for one role sequentially.
- Generated TypeScript client: `pnpm build` → `packages/shared/src/generated` (import from `@scout/shared/program`).

## Deployments

- Program `CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2` (localnet and devnet). Built with `opt-level = "z"`, 515 880 bytes (program data 522 048).
- **Devnet keys** (`~/.config/solana/superrecruiter/`, plus `~/.config/solana/id.json`):

| Key | Address | Role |
|---|---|---|
| `upgrade-authority.json` | `EJRLKuFkSQtbtb6sVyEBDNniQUKrPkFpTGJDyLdQq8qC` | Program upgrade authority and Config admin. A cold key that no service loads. |
| `relayer.json` | `GsaEBURHsvf8FYRPjHNaT2UpDZ7VppTnB2oroH88bfbm` | Fee and rent payer for every user transaction (the backend's `RELAYER_KEYPAIR`). Holds about 1 SOL. |
| `treasury.json` | `E42pLs7vGq8q5SvpaKLUaeyZLmZJXqH9zFSuNGxgw1JH` | Platform fee wallet. |
| `agent.json` | `A3WfA3F7m7tgUNxVQowwBhZFXmUAj1K5329WWv4v3y9r` | Demo AI agent (`role.agent`, gatekeeper). Holds no SOL. |
| `id.json` (deployer) | `8VJdBDpp55sENHDpQjJaGdWXBFQwnZ28KZ6cf5SQBv1f` | Pays upgrade buffers. Mock-USDC mint authority. |

- Config v2 `CoJLM9BvicaPtUT6QPCN5qu2JASYWSpgsJV5Jf7cZ9rY`: fee 10%, min_bounty 0.5 USDC, min_reputable 1 USDC, windows 60 s – 90 days. Mock USDC `2bK9qWsavQ7KYRPgaurwkfcaVAQkDFx4UA3dd7fVi7vm` (unchanged).
- **Upgrading devnet now that the authority is cold:**
  `solana program deploy target/deploy/scout.so --program-id target/deploy/scout-keypair.json --upgrade-authority ~/.config/solana/superrecruiter/upgrade-authority.json --keypair ~/.config/solana/id.json --url <RPC>`
  If the binary grew by less than 10 KiB, auto-extend fails ("ExtendProgram requires a minimum of 10240 additional bytes"). Extend first with the authority paying: `solana program extend <PROGRAM_ID> 10240 --keypair ~/.config/solana/superrecruiter/upgrade-authority.json --url <RPC>`.
  Then `anchor idl upgrade … --provider.wallet ~/.config/solana/superrecruiter/upgrade-authority.json`. The cold key holds 0.05 SOL for IDL writes.
- **History:** v1 (candidate escrow) → v2 (holdback and operators) → v3 (tasks) → v3.1 (bond, separation of duties, security fixes; tx `2bk5AEFo…`) → v3.2 (gatekeeper, agent caps, bounds, Config v2; tx `5nHnMUEYJTfUSFgZTiRNJFNtRHAzf7fFvX4dFZLs1D4T67JJ7v9MEJ4WWsnZ4VYaaSopYmc5yy4MyXUxEcYWTfn2`) → v3.3 (company always a gatekeeper, review and reason hashes, sourcing confirmation attestor; first upgrade signed by the cold key, tx `Jbbm8wdm9xixPncFTcbqcVceffA8vwioPRPW2pZtydeHkg7e9A8UcPA5HvFpN5ruDEpPVCQjKwC5DiGLCcr7eMq`). v3.3 changed only the Task and Submission layouts; RoleVault, Config, ScoutProfile and Operator are unchanged. Each layout change abandoned the older role, task and submission accounts (test funds only). `reset:demo` only looks at 277-byte RoleVaults. ScoutProfile and Operator have kept their layout since v3, so Ola's vouched profile survives.
- `anchor test` runs Surfpool in `transaction` mode (time moves via `surfnet_timeTravel`). `pnpm localnet` (`scripts/localnet.sh`) runs it in `clock` mode for the app.
- Scripts on devnet use `RPC_URL` from `backend/.env` (Helius); only the public URL is written to `deployments/devnet.json`.
