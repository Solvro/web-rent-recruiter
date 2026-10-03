use anchor_lang::prelude::*;

use crate::state::{Outcome, TaskType};

#[event]
pub struct RoleCreated {
    pub role_vault: Pubkey,
    pub company: Pubkey,
    pub role_id: u64,
    pub agent: Option<Pubkey>,
    pub initial_deposit: u64,
}

#[event]
pub struct RoleToppedUp {
    pub role_vault: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct TaskCreated {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub task_id: u32,
    pub task_type: TaskType,
    pub bounty: u64,
    pub max_deliverables: u16,
    pub exclusive: bool,
    pub brief_hash: [u8; 32],
    pub holdback_bps: u16,
    pub subject_scout: Option<Pubkey>,
    pub min_accepted: u16,
    pub min_accept_rate_bps: u16,
    pub bond_bps: u16,
    pub confirmation_attestor: Option<Pubkey>,
    pub created_by: Pubkey,
}

#[event]
pub struct TaskClaimed {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub scout: Pubkey,
}

#[event]
pub struct ClaimReleased {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub scout: Pubkey,
    pub released_by: Pubkey,
}

#[event]
pub struct TaskClosed {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub accepted: u16,
}

#[event]
pub struct DeliverableSubmitted {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub deliverable_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub bond: u64,
    pub review_deadline: i64,
}

#[event]
pub struct SubmissionAccepted {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub task_type: TaskType,
    /// Paid to the scout now.
    pub payout: u64,
    pub fee: u64,
    pub operator: Option<Pubkey>,
    pub operator_fee: u64,
    /// Parked in the vault until `attest_outcome` or `release_holdback`.
    pub held_back: u64,
    pub holdback_deadline: i64,
    pub bond_refunded: u64,
    pub auto_settled: bool,
    pub accepted_by: Pubkey,
    pub review_hash: [u8; 32],
}

#[event]
pub struct SubmissionRejected {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub reason_code: u8,
    /// sha256 of the human-readable reason sent to the scout: a verifiable record of why.
    pub reason_hash: [u8; 32],
    pub rejected_by: Pubkey,
}

#[event]
pub struct OutcomeAttested {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub operator: Option<Pubkey>,
    pub outcome: Outcome,
    pub reason_code: u8,
    pub released: u64,
    pub refunded: u64,
}

#[event]
pub struct HoldbackReleased {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RoleClosed {
    pub role_vault: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct OperatorRegistered {
    pub operator: Pubkey,
    pub authority: Pubkey,
    pub name: String,
    pub fee_bps: u16,
}

#[event]
pub struct ScoutRegistered {
    pub scout: Pubkey,
    pub scout_profile: Pubkey,
    pub operator: Option<Pubkey>,
}

#[event]
pub struct BondForfeited {
    pub role_vault: Pubkey,
    pub task: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AgentUpdated {
    pub role_vault: Pubkey,
    pub agent: Option<Pubkey>,
    pub agent_max_bounty: u64,
    pub agent_max_commitment: u64,
}

#[event]
pub struct ConfigUpdated {
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub min_bounty: u64,
    pub min_reputable_bounty: u64,
    pub min_window_seconds: i64,
    pub max_window_seconds: i64,
}
