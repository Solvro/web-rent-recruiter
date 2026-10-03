use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ScoutError,
    events::HoldbackReleased,
    instructions::payout::transfer_from_vault,
    state::{Outcome, RoleVault, ScoutProfile, Submission, SubmissionStatus, Task},
};

#[derive(Accounts)]
pub struct ReleaseHoldback<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = mint, has_one = vault_token_account)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        seeds = [TASK_SEED, role_vault.key().as_ref(), &task.task_id.to_le_bytes()],
        bump = task.bump,
        has_one = role_vault
    )]
    pub task: Box<Account<'info, Task>>,
    #[account(
        mut,
        seeds = [SUBMISSION_SEED, task.key().as_ref(), submission.deliverable_hash.as_ref()],
        bump = submission.bump,
        has_one = task
    )]
    pub submission: Box<Account<'info, Submission>>,
    #[account(mut, seeds = [SCOUT_SEED, submission.scout.as_ref()], bump = scout_profile.bump)]
    pub scout_profile: Box<Account<'info, ScoutProfile>>,
    #[account(mut)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = scout_token_account.owner == submission.scout @ ScoutError::InvalidTokenAccount,
        constraint = scout_token_account.mint == mint.key() @ ScoutError::InvalidTokenAccount
    )]
    pub scout_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless: once the holdback window passes without a `Fabricated` claim, the scout is paid.
pub fn handle_release_holdback(ctx: Context<ReleaseHoldback>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.submission.status == SubmissionStatus::Accepted, ScoutError::NotAccepted);
    require!(a.submission.outcome == Outcome::None, ScoutError::OutcomeAlreadySet);
    let held = a.submission.holdback_amount;
    require!(held > 0, ScoutError::NothingHeldBack);
    let now = Clock::get()?.unix_timestamp;
    require!(now > a.submission.holdback_deadline, ScoutError::HoldbackWindowOpen);

    transfer_from_vault(&a.role_vault, &a.vault_token_account, &a.scout_token_account, &a.mint, &a.token_program, held)?;
    a.submission.holdback_amount = 0; // released exactly once
    a.role_vault.held_back_total = a.role_vault.held_back_total.checked_sub(held).ok_or(ScoutError::Overflow)?;
    a.role_vault.total_paid = a.role_vault.total_paid.checked_add(held).ok_or(ScoutError::Overflow)?;
    a.scout_profile.total_earned = a.scout_profile.total_earned.checked_add(held).ok_or(ScoutError::Overflow)?;
    a.vault_token_account.reload()?;
    crate::invariants::check_role(&a.role_vault, a.vault_token_account.amount)?;

    emit!(HoldbackReleased {
        role_vault: a.role_vault.key(),
        task: a.task.key(),
        submission: a.submission.key(),
        scout: a.submission.scout,
        amount: held,
    });
    Ok(())
}
