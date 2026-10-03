# Scout program interface (contract)

Agreed interface between the Anchor program (`programs/scout`) and its clients. The IDL generated from the program is the source of truth once it exists. Until then, build against this file. Changing anything here means updating every stream.

- Anchor 1.1.x, Token Interface (classic SPL Token mint, 6 decimals, labelled USDC).
- Amounts are `u64` base units. Timestamps are `i64` unix seconds from `Clock`.
- **Every instruction has a separate `payer: Signer (mut)`.** The backend relayer pays fees and rent, and users only sign as authorities. `payer` may equal the authority.
- Vault token account = associated token account of the RoleVault PDA (`allowOwnerOffCurve`).

## Accounts

| Account | Seeds | Fields |
|---|---|---|
| `Config` | `["config"]` | admin, treasury (wallet), treasury_token_account, fee_bps: u16, usdc_mint, bump |
| `RoleVault` | `["role", company, role_id.to_le_bytes()]` | company, role_id: u64, mint, vault_token_account, bounty_per_candidate: u64, max_candidates: u16, accepted_count: u16, pending_count: u16, total_deposited: u64, total_paid: u64, review_window_seconds: i64, fee_bps: u16, agent: Option<Pubkey>, status: RoleStatus {Open, Closed}, bump |
| `ScoutProfile` | `["scout", scout]` | scout, submitted: u32, accepted: u32, rejected: u32, total_earned: u64, bump |
| `Submission` | `["submission", role_vault, candidate_hash]` | role_vault, scout, candidate_hash: [u8; 32], submitted_at: i64, review_deadline: i64, status: SubmissionStatus {Pending, Accepted, Rejected}, reject_reason: u8 (255 = none), bump |

## Instructions

| # | Instruction | Args | Signers | Effect |
|---|---|---|---|---|
| 1 | `initialize_config` | fee_bps: u16, treasury: Pubkey | payer, admin | Creates Config and the treasury ATA (init_if_needed). Accounts: `treasury_wallet` (must equal the `treasury` arg), `usdc_mint`. |
| 2 | `create_role` | role_id: u64, bounty_per_candidate: u64, max_candidates: u16, review_window_seconds: i64, initial_deposit: u64, agent: Option<Pubkey> | payer, company | Creates the RoleVault and its vault ATA, snapshots fee_bps, and transfers initial_deposit from the company ATA. |
| 3 | `top_up` | amount: u64 | payer, company | Transfers from the company ATA to the vault. Role must be Open. |
| 4 | `register_scout` | none | payer, scout | Creates ScoutProfile and the scout's USDC ATA (init_if_needed), so payouts never need to create accounts. |
| 5 | `submit_candidate` | candidate_hash: [u8; 32] | payer, scout | Role must be Open. `accepted_count + pending_count < max_candidates` and vault balance ≥ `(pending_count + 1) * bounty`, so every pending submission is fully funded. Creates the Submission (deadline = now + window). A duplicate hash fails because the PDA already exists. Increments pending_count and profile.submitted. |
| 6 | `accept_submission` | none | payer, authority (company or role.agent) | Pending only. Pays the scout `bounty - fee` and the treasury `fee`, where `fee = bounty * fee_bps / 10000`. Updates counters and the profile (accepted, total_earned). |
| 7 | `reject_submission` | reason_code: u8 (0..=3) | payer, company | Pending only and only while `now <= review_deadline` (after that the scout is owed the auto-accept). Sets Rejected, decrements pending, increments profile.rejected. |
| 8 | `settle_expired` | none | payer (anyone) | Pending and `now > review_deadline`: same payout as accept. |
| 9 | `close_role` | none | payer, company | Requires `pending_count == 0`. Refunds the vault balance to the company ATA and sets the role to Closed. |

Accounts for 6 and 8: config, role_vault, submission, scout_profile, vault_token_account, scout_token_account, treasury_token_account, mint, token_program.

Errors (`ScoutError`): InvalidFee, InvalidRoleParams, InvalidAmount, RoleClosed, RoleFull, InsufficientBudget, NotPending, Unauthorized, ReviewWindowOpen, ReviewWindowExpired, InvalidReason, PendingSubmissions, InvalidTokenAccount, Overflow. A duplicate candidate fails with the system program's "already in use" error on the Submission PDA.

Reject reasons: 0 NOT_MATCHING, 1 NOT_INTERESTED, 2 ALREADY_IN_PIPELINE, 3 OTHER.

## Events

- `RoleCreated { role_vault, company, role_id, bounty_per_candidate, max_candidates, initial_deposit }`
- `RoleToppedUp { role_vault, amount, total_deposited }`
- `CandidateSubmitted { role_vault, submission, scout, candidate_hash, review_deadline }`
- `SubmissionAccepted { role_vault, submission, scout, payout, fee, auto_settled: bool }`
- `SubmissionRejected { role_vault, submission, scout, reason_code }`
- `RoleClosed { role_vault, refunded }`

## Off-chain conventions

- `candidate_hash = sha256(role_salt + normalize(profileUrl))`. `role_salt` is 16 random bytes (hex) per role and is stored in Postgres only. `normalize` lowercases the URL and strips the protocol, `www.`, the query string, the hash and a trailing slash.
- `role_id` is assigned by the backend as a u64 (a DB sequence).
- Generated TypeScript client: `pnpm build` → `packages/shared/src/generated` (import from `@scout/shared/program`).

## Deployments

- Program ID (localnet and devnet): `CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2`. The upgrade authority is the deployer (`~/.config/solana/id.json`).
- `deployments/<cluster>.json` holds `{ programId, usdcMint, usdcDecimals, config, treasury, treasuryTokenAccount, feeBps, tokenProgram, rpcUrl }`. The backend reads it.
- Demo wallets in `~/.config/solana/superrecruiter/`: `client.json` = **company**, `recruiter.json` = **scout**, `scout2.json` = **second scout** (the duplicate-candidate step). The deployer doubles as the relayer (fee payer) and the treasury.
- Local Surfpool runs in `clock` block-production mode (Anchor.toml), so review windows follow wall time. Tests jump the clock with `surfnet_timeTravel`.
