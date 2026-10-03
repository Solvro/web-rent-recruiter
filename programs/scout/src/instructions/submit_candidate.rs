use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    error::ScoutError,
    events::CandidateSubmitted,
    state::{RoleStatus, RoleVault, ScoutProfile, Submission, SubmissionStatus},
};

#[derive(Accounts)]
#[instruction(candidate_hash: [u8; 32])]
pub struct SubmitCandidate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub scout: Signer<'info>,
    #[account(mut, has_one = vault_token_account)]
    pub role_vault: Account<'info, RoleVault>,
    #[account(mut, seeds = [SCOUT_SEED, scout.key().as_ref()], bump = scout_profile.bump, has_one = scout)]
    pub scout_profile: Account<'info, ScoutProfile>,
    /// The PDA is unique per (role, candidate): a second submission of the same
    /// candidate fails here, so the first scout keeps the credit.
    #[account(
        init,
        payer = payer,
        space = 8 + Submission::INIT_SPACE,
        seeds = [SUBMISSION_SEED, role_vault.key().as_ref(), candidate_hash.as_ref()],
        bump
    )]
    pub submission: Account<'info, Submission>,
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

pub fn handle_submit_candidate(ctx: Context<SubmitCandidate>, candidate_hash: [u8; 32]) -> Result<()> {
    let accounts = ctx.accounts;
    let role = &mut accounts.role_vault;
    require!(role.status == RoleStatus::Open, ScoutError::RoleClosed);

    let in_flight = u32::from(role.accepted_count) + u32::from(role.pending_count);
    require!(in_flight < u32::from(role.max_candidates), ScoutError::RoleFull);

    // Every pending submission must be fully funded, so a scout never works for a bounty the vault can't pay.
    let needed = u64::from(role.pending_count)
        .checked_add(1)
        .and_then(|n| n.checked_mul(role.bounty_per_candidate))
        .ok_or(ScoutError::Overflow)?;
    require!(accounts.vault_token_account.amount >= needed, ScoutError::InsufficientBudget);

    let now = Clock::get()?.unix_timestamp;
    let review_deadline = now.checked_add(role.review_window_seconds).ok_or(ScoutError::Overflow)?;
    *accounts.submission = Submission {
        role_vault: role.key(),
        scout: accounts.scout.key(),
        candidate_hash,
        submitted_at: now,
        review_deadline,
        status: SubmissionStatus::Pending,
        reject_reason: NO_REJECT_REASON,
        bump: ctx.bumps.submission,
    };

    role.pending_count = role.pending_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    let profile = &mut accounts.scout_profile;
    profile.submitted = profile.submitted.checked_add(1).ok_or(ScoutError::Overflow)?;

    emit!(CandidateSubmitted {
        role_vault: role.key(),
        submission: accounts.submission.key(),
        scout: accounts.scout.key(),
        candidate_hash,
        review_deadline,
    });
    Ok(())
}
