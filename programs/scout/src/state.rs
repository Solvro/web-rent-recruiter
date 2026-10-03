use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub treasury_token_account: Pubkey,
    pub fee_bps: u16,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum RoleStatus {
    Open,
    Closed,
}

#[account]
#[derive(InitSpace)]
pub struct RoleVault {
    pub company: Pubkey,
    pub role_id: u64,
    pub mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub bounty_per_candidate: u64,
    pub max_candidates: u16,
    pub accepted_count: u16,
    pub pending_count: u16,
    pub total_deposited: u64,
    pub total_paid: u64,
    pub review_window_seconds: i64,
    /// Snapshot of `Config::fee_bps` at creation, so later fee changes don't affect open roles.
    pub fee_bps: u16,
    /// Optional delegate (the AI agent) allowed to accept on the company's behalf.
    pub agent: Option<Pubkey>,
    pub status: RoleStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ScoutProfile {
    pub scout: Pubkey,
    pub submitted: u32,
    pub accepted: u32,
    pub rejected: u32,
    pub total_earned: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum SubmissionStatus {
    Pending,
    Accepted,
    Rejected,
}

#[account]
#[derive(InitSpace)]
pub struct Submission {
    pub role_vault: Pubkey,
    pub scout: Pubkey,
    pub candidate_hash: [u8; 32],
    pub submitted_at: i64,
    pub review_deadline: i64,
    pub status: SubmissionStatus,
    /// 0..=3, or 255 while not rejected.
    pub reject_reason: u8,
    pub bump: u8,
}
