use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ScoutError,
    events::SubmissionRejected,
    state::{RoleVault, ScoutProfile, Submission, SubmissionStatus},
};

#[derive(Accounts)]
pub struct RejectSubmission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub company: Signer<'info>,
    #[account(mut, has_one = company)]
    pub role_vault: Account<'info, RoleVault>,
    #[account(
        mut,
        seeds = [SUBMISSION_SEED, role_vault.key().as_ref(), submission.candidate_hash.as_ref()],
        bump = submission.bump,
        has_one = role_vault
    )]
    pub submission: Account<'info, Submission>,
    #[account(mut, seeds = [SCOUT_SEED, submission.scout.as_ref()], bump = scout_profile.bump)]
    pub scout_profile: Account<'info, ScoutProfile>,
}

pub fn handle_reject_submission(ctx: Context<RejectSubmission>, reason_code: u8) -> Result<()> {
    require!(reason_code <= MAX_REJECT_REASON, ScoutError::InvalidReason);
    let a = ctx.accounts;
    require!(a.submission.status == SubmissionStatus::Pending, ScoutError::NotPending);
    // After the window the scout is owed the auto-accept; the company can't race it with a late reject.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= a.submission.review_deadline, ScoutError::ReviewWindowExpired);

    a.submission.status = SubmissionStatus::Rejected;
    a.submission.reject_reason = reason_code;
    a.role_vault.pending_count = a.role_vault.pending_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    a.scout_profile.rejected = a.scout_profile.rejected.checked_add(1).ok_or(ScoutError::Overflow)?;

    emit!(SubmissionRejected {
        role_vault: a.role_vault.key(),
        submission: a.submission.key(),
        scout: a.submission.scout,
        reason_code,
    });
    Ok(())
}
