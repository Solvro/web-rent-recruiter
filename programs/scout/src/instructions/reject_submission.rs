use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ScoutError,
    events::{BondForfeited, SubmissionRejected},
    instructions::auth::require_company_or_agent,
    state::{RoleVault, ScoutProfile, Submission, SubmissionStatus, Task},
};

#[derive(Accounts)]
pub struct RejectSubmission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The company or `role_vault.agent`.
    pub authority: Signer<'info>,
    #[account(mut)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        mut,
        seeds = [TASK_SEED, role_vault.key().as_ref(), &task.task_id.to_le_bytes()],
        bump = task.bump,
        has_one = role_vault
    )]
    pub task: Box<Account<'info, Task>>,
    /// Closed: a rejected deliverable leaves no account behind; its rent goes back to whoever paid it.
    /// (Accepted submissions stay: they are the dedupe record and the reputation trail.)
    #[account(
        mut,
        seeds = [SUBMISSION_SEED, task.key().as_ref(), submission.deliverable_hash.as_ref()],
        bump = submission.bump,
        has_one = task,
        has_one = rent_payer,
        close = rent_payer
    )]
    pub submission: Box<Account<'info, Submission>>,
    /// CHECK: must equal `submission.rent_payer` (has_one above); only receives lamports.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SCOUT_SEED, submission.scout.as_ref()], bump = scout_profile.bump)]
    pub scout_profile: Box<Account<'info, ScoutProfile>>,
}

pub fn handle_reject_submission(ctx: Context<RejectSubmission>, reason_code: u8, reason_hash: [u8; 32]) -> Result<()> {
    require!(reason_code <= MAX_REJECT_REASON, ScoutError::InvalidReason);
    let a = ctx.accounts;
    let signer = a.authority.key();
    require_company_or_agent(&a.role_vault, &signer)?;
    require!(a.submission.status == SubmissionStatus::Pending, ScoutError::NotPending);
    // After the window the scout is owed the auto-accept; no late reject can race it.
    let now = Clock::get()?.unix_timestamp;
    require!(now <= a.submission.review_deadline, ScoutError::ReviewWindowExpired);

    let bounty = a.task.bounty;
    a.submission.status = SubmissionStatus::Rejected;
    a.submission.reject_reason = reason_code;
    a.task.pending_count = a.task.pending_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    // A rejected claimant loses the exclusive claim, so a squatter can't hold the gig hostage.
    if a.task.exclusive && a.task.claimant == Some(a.submission.scout) {
        a.task.claimant = None;
        a.task.claimed_at = 0;
    }
    a.role_vault.pending_count = a.role_vault.pending_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    a.role_vault.pending_value = a.role_vault.pending_value.checked_sub(bounty).ok_or(ScoutError::Overflow)?;
    if a.task.reputable {
        a.scout_profile.rejected = a.scout_profile.rejected.checked_add(1).ok_or(ScoutError::Overflow)?;
    }
    // A rejected deliverable forfeits its bond: it stays in the vault as company budget.
    let bond = a.submission.bond_amount;
    if bond > 0 {
        a.role_vault.bonds_held = a.role_vault.bonds_held.checked_sub(bond).ok_or(ScoutError::Overflow)?;
        a.role_vault.total_deposited = a.role_vault.total_deposited.checked_add(bond).ok_or(ScoutError::Overflow)?;
        emit!(BondForfeited {
            role_vault: a.role_vault.key(),
            task: a.task.key(),
            submission: a.submission.key(),
            scout: a.submission.scout,
            amount: bond,
        });
    }
    crate::invariants::check_task(&a.task)?;

    emit!(SubmissionRejected {
        role_vault: a.role_vault.key(),
        task: a.task.key(),
        submission: a.submission.key(),
        scout: a.submission.scout,
        reason_code,
        reason_hash,
        rejected_by: signer,
    });
    Ok(())
}
