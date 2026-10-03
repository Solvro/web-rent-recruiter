use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub treasury_token_account: Pubkey,
    pub fee_bps: u16,
    pub usdc_mint: Pubkey,
    /// Smallest bounty a task may have (base units).
    pub min_bounty: u64,
    /// Accepted deliverables only count towards reputation when the task's bounty is at least this.
    pub min_reputable_bounty: u64,
    /// Bounds for every role window (review, claim timeout, holdback).
    pub min_window_seconds: i64,
    pub max_window_seconds: i64,
    pub bump: u8,
}

/// Admin-settable parameters, validated by `ConfigParams::validate`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ConfigParams {
    pub fee_bps: u16,
    pub min_bounty: u64,
    pub min_reputable_bounty: u64,
    pub min_window_seconds: i64,
    pub max_window_seconds: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TaskType {
    /// One deliverable = one candidate (profile link + note).
    Sourcing,
    /// A call with a candidate following the agent's question script; deliverable = answers + recommendation.
    ScreeningCall,
    /// A reference call for a finalist; deliverable = structured answers.
    ReferenceCheck,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Status {
    Open,
    Closed,
}

/// The role budget. Owned by its PDA; the company funds it, the agent (`agent`) spends it via tasks.
#[account]
#[derive(InitSpace)]
pub struct RoleVault {
    pub company: Pubkey,
    pub role_id: u64,
    pub mint: Pubkey,
    pub vault_token_account: Pubkey,
    /// The AI agent's wallet: may create/close tasks, accept/reject deliverables and attest outcomes.
    pub agent: Option<Pubkey>,
    /// Snapshots of Config at creation: later config changes never alter an open role's terms.
    pub fee_bps: u16,
    pub min_bounty: u64,
    pub min_reputable_bounty: u64,
    /// Company-signed limits on the agent: per-task bounty, and the total its tasks may ever pay
    /// (accepted + still promised). Bounds the damage of a compromised agent key.
    pub agent_max_bounty: u64,
    pub agent_max_commitment: u64,
    /// Σ over agent-created tasks of max_deliverables × bounty, minus unused slots of closed ones.
    pub agent_committed: u64,
    pub review_window_seconds: i64,
    /// After this long a company/agent may release an exclusive claim with nothing pending.
    pub claim_timeout_seconds: i64,
    pub holdback_window_seconds: i64,
    /// Next task id; tasks are numbered 0, 1, 2, ...
    pub task_count: u32,
    pub open_task_count: u32,
    pub accepted_count: u32,
    pub pending_count: u32,
    /// Σ over pending deliverables of their task bounty (each one fully funded).
    pub pending_value: u64,
    /// Σ over open tasks of (max_deliverables − accepted) × bounty: what the open tasks promise.
    pub open_capacity: u64,
    pub held_back_total: u64,
    /// Σ deliverable bonds currently held for pending submissions (scouts' money, not budget).
    pub bonds_held: u64,
    pub total_deposited: u64,
    pub total_paid: u64,
    pub status: Status,
    pub bump: u8,
}

/// A gig the agent posts against the role budget.
#[account]
#[derive(InitSpace)]
pub struct Task {
    pub role_vault: Pubkey,
    pub task_id: u32,
    pub task_type: TaskType,
    pub bounty: u64,
    pub max_deliverables: u16,
    pub accepted_count: u16,
    pub pending_count: u16,
    /// Exclusive gigs (screening, reference) have a single claimant who alone may deliver.
    pub exclusive: bool,
    pub claimant: Option<Pubkey>,
    pub claimed_at: i64,
    /// sha256 of the off-chain brief / question script.
    pub brief_hash: [u8; 32],
    /// Share of the scout's payout held back after acceptance (0..=5000 bps).
    pub holdback_bps: u16,
    /// Separation of duties: the scout who sourced the candidate this task is about (screening,
    /// reference) can't claim or deliver it.
    pub subject_scout: Option<Pubkey>,
    /// Reputation gate: claiming needs `ScoutProfile.sourcing_accepted >= min_accepted`…
    pub min_accepted: u16,
    /// …and an acceptance rate `accepted / submitted >= min_accept_rate_bps / 10000` (0 = off).
    pub min_accept_rate_bps: u16,
    /// Who attests that a sourced candidate confirmed interest (off-chain), which is what lets an
    /// expired SOURCING deliverable be settled. `None` = whoever is `role.agent` at settle time.
    /// The company can always settle too. Any implementation can be the attestor.
    pub confirmation_attestor: Option<Pubkey>,
    /// Created by the agent (counts against `agent_committed`) rather than the company.
    pub created_by_agent: bool,
    /// `bounty >= role.min_reputable_bounty`: accepted deliverables count towards reputation.
    pub reputable: bool,
    /// Deliverable bond for scouts without an operator: `bounty * bond_bps / 10000` (0..=2000 bps),
    /// returned on accept/settle, forfeited to the role budget on reject.
    pub bond_bps: u16,
    pub status: Status,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ScoutProfile {
    pub scout: Pubkey,
    pub submitted: u32,
    pub accepted: u32,
    pub rejected: u32,
    pub sourcing_accepted: u32,
    pub screening_accepted: u32,
    pub reference_accepted: u32,
    /// Accepted deliverables the company/agent later confirmed as `Advanced`.
    pub advanced: u32,
    /// Accepted deliverables attested as `Fabricated`.
    pub flagged: u32,
    pub total_earned: u64,
    /// Operator PDA that vouched for this scout; takes `fee_bps` of payouts.
    pub operator: Option<Pubkey>,
    pub bump: u8,
}

/// A recruiting academy / agency that trains and vouches for scouts and earns a cut of their payouts.
#[account]
#[derive(InitSpace)]
pub struct Operator {
    pub authority: Pubkey,
    #[max_len(32)]
    pub name: String,
    /// Taken from the scout's share (after the platform fee), never on top of the bounty. ≤ 2000.
    pub fee_bps: u16,
    /// The authority's USDC token account that receives operator fees.
    pub token_account: Pubkey,
    pub recruiters: u32,
    pub accepted: u32,
    pub advanced: u32,
    pub flagged: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum SubmissionStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Outcome {
    None,
    Advanced,
    Fabricated,
}

/// One deliverable for a task. PDA `["submission", task, deliverable_hash]`: the same deliverable
/// (e.g. the same candidate) can't be submitted twice to a task, and the first scout keeps the credit.
#[account]
#[derive(InitSpace)]
pub struct Submission {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub scout: Pubkey,
    /// Sourcing: sha256(role_salt + normalized profile URL). Other gigs: hash identifying the deliverable.
    pub deliverable_hash: [u8; 32],
    /// sha256 of the off-chain notes; zeroes allowed for Sourcing.
    pub evidence_hash: [u8; 32],
    pub submitted_at: i64,
    pub review_deadline: i64,
    pub status: SubmissionStatus,
    /// 0..=3, or 255 while not rejected.
    pub reject_reason: u8,
    pub holdback_amount: u64,
    /// Who paid the account's rent (the relayer); refunded when a rejected submission is closed.
    pub rent_payer: Pubkey,
    /// Bond the scout posted with this deliverable (0 if vouched or the task has no bond).
    pub bond_amount: u64,
    /// accepted_at + holdback_window_seconds; 0 while pending.
    pub holdback_deadline: i64,
    pub outcome: Outcome,
    /// sha256 of the reviewer's off-chain review (zeroes allowed). Rejections emit `reason_hash`
    /// in `SubmissionRejected` instead (the account is closed).
    pub review_hash: [u8; 32],
    pub bump: u8,
}

impl ConfigParams {
    pub fn is_valid(&self) -> bool {
        self.fee_bps <= crate::constants::MAX_FEE_BPS
            && self.min_bounty > 0
            && self.min_reputable_bounty >= self.min_bounty
            && self.min_window_seconds >= crate::constants::ABS_MIN_WINDOW_SECONDS
            && self.max_window_seconds <= crate::constants::ABS_MAX_WINDOW_SECONDS
            && self.min_window_seconds <= self.max_window_seconds
    }
}

impl Config {
    pub fn window_ok(&self, seconds: i64) -> bool {
        (self.min_window_seconds..=self.max_window_seconds).contains(&seconds)
    }
}

impl Task {
    /// The reputation gate for claiming / delivering this task (a typical screener gate is
    /// min_accepted = 10, min_accept_rate_bps = 5000). Counters only include reputable tasks.
    pub fn reputation_ok(&self, profile: &ScoutProfile) -> bool {
        if profile.sourcing_accepted < u32::from(self.min_accepted) {
            return false;
        }
        if self.min_accept_rate_bps == 0 {
            return true;
        }
        // No history means no rate yet: a rate gate can't be met by a newcomer.
        profile.submitted > 0
            && u64::from(profile.accepted) * crate::constants::BPS_DENOMINATOR
                >= u64::from(profile.submitted) * u64::from(self.min_accept_rate_bps)
    }
}

impl RoleVault {
    /// Gatekeepers co-sign deliverables and claims: the agent **or** the company, always. Nothing
    /// depends on one particular agent: if it is down or distrusted, the company signs itself.
    /// A scout alone can't push "ghost" deliverables straight to the chain.
    pub fn is_gatekeeper(&self, key: &Pubkey) -> bool {
        *key == self.company || self.agent == Some(*key)
    }
}
