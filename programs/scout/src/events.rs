use anchor_lang::prelude::*;

#[event]
pub struct RoleCreated {
    pub role_vault: Pubkey,
    pub company: Pubkey,
    pub role_id: u64,
    pub bounty_per_candidate: u64,
    pub max_candidates: u16,
    pub initial_deposit: u64,
}

#[event]
pub struct RoleToppedUp {
    pub role_vault: Pubkey,
    pub amount: u64,
    pub total_deposited: u64,
}

#[event]
pub struct CandidateSubmitted {
    pub role_vault: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub candidate_hash: [u8; 32],
    pub review_deadline: i64,
}

#[event]
pub struct SubmissionAccepted {
    pub role_vault: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub payout: u64,
    pub fee: u64,
    pub auto_settled: bool,
}

#[event]
pub struct SubmissionRejected {
    pub role_vault: Pubkey,
    pub submission: Pubkey,
    pub scout: Pubkey,
    pub reason_code: u8,
}

#[event]
pub struct RoleClosed {
    pub role_vault: Pubkey,
    pub refunded: u64,
}
