# Security notes: the Scout program

Scope: the on-chain program `programs/scout` (Anchor 1.1, program `CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2` on devnet, v3.3). The backend, agent and app are out of scope except where they hold keys. Reference: [program-interface.md](program-interface.md).

**One-line summary:** the company's budget sits in a program-owned vault. Money leaves it only to the scout who delivered (and that scout's operator), to the configured treasury, or back to the company, by rules nobody can change for an open role. The platform can't take a role's funds. The agent can only spend within limits the company signed.

## 0. What depends on whom (protocol, not platform)

Scout is a protocol. Our backend and AI agent are one implementation of the roles below, and nothing in the program requires them:

| Function | Who can perform it on-chain | If our agent or backend disappears |
|---|---|---|
| Fund, top up, close a role | Company | Unaffected |
| Post gigs (`create_task`) | Company or `role.agent` | The company posts them itself, or points `set_agent` at a self-hosted agent. |
| Co-sign claims and deliveries (gatekeeper) | Company or `role.agent` | The company co-signs. No `set_agent` call is needed first. |
| Accept or reject, with review or reason hashes | Company or `role.agent` | The company reviews. |
| Pay a reviewed-silent non-sourcing deliverable | Anyone, after `review_deadline` | The scout or anyone calls `settle_expired`. |
| Pay a silent sourcing deliverable | `task.confirmation_attestor` (any key, default the current `role.agent`) or the company | The company settles, or any independent confirmation service set as attestor at `create_task`. |
| Release a holdback after its window | Anyone | Unaffected |
| Fee payer (relayer) | Anyone with SOL | Users or any relayer can pay their own fees; the program never checks who the payer is. |

Known limitation: an unrecorded ("self-reported") screening or language call is only paid after the candidate confirms the call happened. That rule lives off-chain: our agent pre-accepts and rejects unconfirmed calls before `review_deadline`. If no reviewer acts before the deadline, `settle_expired` still pays the call permissionlessly, because on-chain all non-sourcing tasks settle on silence. Closing this gap would need an attestor for call tasks too, the same way sourcing works.

The platform's remaining privileged roles are the **Config admin** (fee within ≤ 20% and bounds for new roles; treasury rotation) and the **upgrade authority** (section 1).

## 1. Trust model: who can do what

| Actor | Key | Can | Cannot |
|---|---|---|---|
| **Company** | its wallet | Fund, top up and close its roles. Create tasks. Accept or reject. Attest outcomes. Rotate or revoke the agent and set its caps (`set_agent`). | Take back money owed to scouts: pending deliverables are funded (I1). Holdbacks can only be clawed back via `Fabricated` inside the holdback window. Reject after the review deadline. Close a role with pending or held money. |
| **Agent** (`role.agent`) | `agent.json` (our backend), or any key the company sets | Create tasks up to `agent_max_bounty` each and `agent_max_commitment` in total. Accept or reject deliverables. Attest outcomes. Release stale claims after `claim_timeout`. Co-sign deliverables and claims (gatekeeper). Attest sourcing confirmations unless the task names another attestor. | Pay itself or the company (`SelfDealing`). Pay anyone who didn't deliver: payouts go only to `submission.scout`'s token account of the role mint. Exceed its caps. Touch other roles. Withdraw from the vault. Change fees. |
| **Scout** | own wallet | Claim exclusive gigs and deliver, with the gatekeeper co-sign. Settle its own expired deliverables. Release its own claim. | Deliver without the gatekeeper's co-signature (no "ghost" deliverables). Deliver to a closed or full task. Review its own candidate (`SelfReview`). Claim gated gigs without the reputation (`ReputationTooLow`). Submit a deliverable that is already on the task. |
| **Operator** | `operator.json` | Vouch for scouts (co-sign `register_scout`). Earn `fee_bps` (≤ 20%) of its scouts' share. | Raise its fee after registration. Receive anything except through payouts of its own scouts. |
| **Relayer** (platform) | `relayer.json` | Pay fees and rent. Call permissionless instructions (`settle_expired`, `release_holdback`). | Sign for any user. Its key is a fee payer only and never an authority on money. |
| **Config admin** = **upgrade authority** | `upgrade-authority.json` (cold) | `update_config`: rotate the treasury, set fee ≤ 20% and the bounds, for **new** roles only (open roles snapshot fee and minimums). **Upgrade the program.** | Change the mint or the admin. Alter an open role's fee. Move vault funds through any instruction. |
| **Anyone** | n/a | `settle_expired` after the review deadline. `release_holdback` after the holdback deadline. | Anything else. |

**The upgrade authority is the platform's real power.** An upgrade can replace the program, and with it every rule above. On devnet it is a separate cold key (not the deployer or the relayer, and never loaded by the backend). For mainnet the plan is a Squads multisig with a timelock, then freezing the program (`--final`) once stable. Until then the honest statement is: *the platform cannot take funds through the program as deployed, but whoever holds the upgrade key could deploy one that does.*

## 2. Invariants

These are enforced as code (`programs/scout/src/invariants.rs`, checked after every budget-changing instruction, error `InvariantViolated`) and asserted from the client after each step in `tests/scout.ts`.

For a role with vault token balance `V`:
- **I1** `V ≥ pending_value + held_back_total + bonds_held`: every pending deliverable is fully funded, and every holdback and bond is still in the vault.
- **I2** `open_capacity ≤ V − held_back_total − bonds_held`: open tasks never promise more than the free budget (checked at `create_task`).
- **I3** `pending_value ≤ open_capacity`.
- **I4** per task: `accepted + pending ≤ max_deliverables`.

Further properties and where they come from:
- **Exactly-once settlement.** Accept, reject and settle require `status == Pending`. Holdback release or refund requires `outcome == None` and sets the outcome or zeroes `holdback_amount`. Tests: "exactly once…", "holdback…".
- **Agent bound:** `agent_committed ≤ agent_max_commitment` at every agent `create_task`. Closing a task returns only unused slots.
- **close_role** requires no open tasks, no pending deliverables and no holdbacks. It sweeps the whole token balance (including anything sent to the vault directly) and closes the vault token account, so no tokens or rent are left behind.

**Why they hold.**
- An accept removes exactly `bounty` from the free budget: `payout + fee + operator_fee` leave the vault and `holdback` moves into `held_back_total`. The split is exact (section 3), and it also removes exactly `bounty` from `open_capacity`.
- A holdback release or refund lowers `V` and `held_back_total` equally.
- A bond raises `V` and `bonds_held` equally. Its return lowers both. Its forfeiture lowers `bonds_held`, so the free budget grows.
- `top_up` and direct transfers only raise `V`.

## 3. Money and rounding

- All maths is in `programs/scout/src/math.rs` as a pure function `split(bounty, fee_bps, operator_bps, holdback_bps)`. Products are computed in `u128` and every sum and difference is checked. The program has no unchecked arithmetic on amounts or counters (`saturating_*` removed in the security pass).
- **Rounding policy:** every percentage is **floored**, and the scout's immediate payout is the remainder. **All dust goes to the scout**, never to the platform or the operator. Identity: `fee + operator_fee + held_back + payout == bounty` for every `u64` bounty and every allowed bps.
- Property tests (`cargo test -p scout --lib`, proptest, 20 000 cases each) check:
  - the identity, for any u64 bounty and bps;
  - every floor is at most its nominal percentage;
  - the scout's share is at least the exact rational share and less than 2 base units above it.
- End to end, the "random bounties" test runs ten bounties (1, 7, 333 333, …) through accept on a local validator. It checks the token deltas of scout, operator, treasury and vault against the formula and the invariants after every step. A second loop does the same with bonds.
- Bond = `floor(bounty × bond_bps / 10000)`. It is not part of the split: returned whole or forfeited whole.
- **Token-2022:** the vault uses `transfer_checked` via Token Interface. A mint with a **transfer fee** would break the exact accounting (the vault would receive less than sent). The admin chooses the mint once and can't change it; mainnet must use classic SPL USDC.

## 4. Account validation

Every account is pinned by type (owner and discriminator), PDA seeds, `has_one` or an explicit constraint:

- **Vault token account:** `role_vault.vault_token_account` (`has_one`), created as the RoleVault PDA's ATA for `config.usdc_mint` at `create_role`. **Mint:** `role_vault.mint` (`has_one`) = `config.usdc_mint`.
- **Scout payout account:** `owner == submission.scout` and `mint == role mint`. **Bond source:** `owner == scout signer` and `mint == role mint`.
- **Treasury:** `config.treasury_token_account` (`has_one` on Config, Config by seeds).
- **Operator account:** must equal `scout_profile.operator`. **Operator fee account:** must equal `operator.token_account`. Both are required exactly when the scout has an operator (`OperatorMismatch`).
- **Company refund account (Fabricated):** `owner == role.company` and `mint == role mint`.
- **Task:** seeds `["task", role_vault, task_id]` plus `has_one = role_vault`. **Submission:** seeds `["submission", task, deliverable_hash]` plus `has_one = task`. **ScoutProfile:** seeds by `submission.scout`.
- **Rejected Submission rent:** goes to `submission.rent_payer` (`has_one`).
- **`initialize_config`:** the admin must be the program's upgrade authority, read from ProgramData, so the one-time init can't be front-run after a deploy.

Negative tests:
- wrong scout ATA owner, wrong mint, wrong treasury, wrong task;
- wrong operator ATA, missing operator;
- non-agent signer, an agent acting on another role, a non-company `set_agent`, a non-admin `update_config`;
- self-dealing, self-review;
- double accept, reject and settle;
- ghost submit and claim without the gatekeeper.

## 5. Abuse and griefing

| Attack | Mitigation |
|---|---|
| **Ghost deliverables:** someone calls `submit_deliverable` directly and waits for `settle_expired`. | Deliverables and claims need a gatekeeper co-signature (`role.agent` or the company). An implementation only co-signs deliverables it received. SOURCING deliverables also need the confirmation attestor (or the company) to settle. |
| **Unaccountable rejections** | `reason_hash` in `SubmissionRejected` commits to the exact text the recruiter was shown, so either side can prove what was said. `review_hash` does the same for accepts. |
| **Compromised agent key** | Limited by the company's caps: at most `agent_max_bounty` per task and `agent_max_commitment` in total, only to scouts who deliver (or sybil wallets the attacker controls). The company revokes it with `set_agent(None)` and closes the open tasks. **Blast radius = `agent_max_commitment` minus what was legitimately spent, never the whole vault.** |
| **Agent paying itself** | `SelfDealing` blocks the agent and the company as scouts. Sybil wallets are still possible within the caps above (see Limitations). |
| **Claim squatting** on exclusive gigs | Claims need the gatekeeper. A rejected claimant loses the claim. The company or agent can release after `claim_timeout` (bounded by the Config window range). |
| **Reputation farming** with dust gigs between colluding wallets | Counters only move on tasks with `bounty ≥ min_reputable_bounty` (1 USDC on devnet), plus the 10% fee per gig. Screening gigs can require `min_accepted` and `min_accept_rate_bps` (e.g. 10 and 50%). |
| **Scout reviewing their own candidate** | `subject_scout` on screening and reference tasks (`SelfReview`). The holdback on the sourcing gig is clawed back if an independent screener reports a fake (`attest_outcome(Fabricated)`, test "separation of duties…"). |
| **Spam deliverables** from unvouched scouts | Bond (`bond_bps`, forfeited on reject) plus the gatekeeper. |
| **Company rejecting at the last second** to avoid paying | Reject is only allowed before `review_deadline`; after it, settle can't be raced. |
| **Company keeping the holdback** | It can only be refunded with `Fabricated` inside the holdback window. The `flagged` counter is public. After the window anyone can release it to the scout. |
| **Front-running `initialize_config`** | The admin must be the upgrade authority. |

## 6. Known limitations

- **Upgrade authority:** see section 1. Single cold key on devnet; multisig and timelock or `--final` before mainnet.
- **Agent key in the backend:** it is a hot key. It is bounded by the caps, and the company should set them close to the planned spend.
- **Candidate hashes:** `deliverable_hash = sha256(role_salt + normalized profile URL)`. The salt lives off-chain in Postgres, so on-chain dedupe is per task. The same candidate on two sourcing tasks of one role isn't blocked by the program; the backend checks across tasks. Without the salt, hashes can't be linked to a person.
- **Rejected deliverables are closed,** so the same deliverable can be resubmitted to the task later (the bond and the gatekeeper make that costly). Accepted ones stay as the dedupe record.
- **No on-chain dispute or arbitration.** The holdback is the only contested money: bounded (≤ 50%) and time-limited. Disputes are off-chain for now.
- **Sybil scouts and agents:** an agent operator could pay wallets it controls within its caps. That's why caps exist and reputation needs reputable bounties. Identity is an operator-vouching problem (roadmap: bonded operators).
- **Clock:** deadlines use `Clock::unix_timestamp`, which validators can skew by a little. Windows are ≥ 60 s on devnet.
- **Sourcing liveness:** an unconfirmed sourcing deliverable stays pending (and funded) until the company or attestor acts. Reject is only possible before `review_deadline`, so a company that ignores it can only settle (pay) it later to close the role. This is intentional: silence must not cost the recruiter.
- **Not audited.** The jury review and this document aren't an audit.

## 7. How to verify

```bash
# Unit and property tests for the money maths (native, no validator)
cargo test -p scout --lib

# Integration tests on a local Surfpool: 39 tests covering every path above
anchor test

# CLI end to end on devnet with throwaway scouts (prints Explorer links)
SCOUT_KEYPAIR=/tmp/a.json SCREENER_KEYPAIR=/tmp/b.json VOUCH=1 CLUSTER=devnet pnpm e2e

# Who controls the program
solana program show CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2 --url devnet   # Authority: EJRLKuFk…
```

Read in this order: `math.rs` (the split), `invariants.rs`, `instructions/payout.rs` (where money moves), `submit_deliverable.rs` and `create_task.rs` (gates and caps), then `tests/scout.ts`.
