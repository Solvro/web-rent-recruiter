use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ScoutError,
    events::OutcomeAttested,
    instructions::payout::transfer_from_vault,
    state::{Operator, Outcome, RoleVault, ScoutProfile, Submission, SubmissionStatus, Task},
};

#[derive(Accounts)]
pub struct AttestOutcome<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The company, or the delegated agent if the role has one.
    pub authority: Signer<'info>,
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
    #[account(
        mut,
        constraint = company_token_account.owner == role_vault.company @ ScoutError::InvalidTokenAccount,
        constraint = company_token_account.mint == mint.key() @ ScoutError::InvalidTokenAccount
    )]
    pub company_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The scout's vouching operator (its quality counters move with the outcome); omit if none.
    #[account(mut)]
    pub operator: Option<Box<Account<'info, Operator>>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The downstream quality signal. `Advanced` releases the holdback to the scout at once;
/// `Fabricated` (only inside the holdback window) refunds it to the company and flags the scout.
pub fn handle_attest_outcome(ctx: Context<AttestOutcome>, outcome: Outcome, reason_code: u8) -> Result<()> {
    let a = ctx.accounts;
    crate::instructions::auth::require_company_or_agent(&a.role_vault, &a.authority.key())?;
    require!(a.submission.status == SubmissionStatus::Accepted, ScoutError::NotAccepted);
    require!(a.submission.outcome == Outcome::None, ScoutError::OutcomeAlreadySet);
    require!(
        a.operator.as_ref().map(|o| o.key()) == a.scout_profile.operator,
        ScoutError::OperatorMismatch
    );

    let held = a.submission.holdback_amount;
    let (released, refunded) = match outcome {
        Outcome::Advanced => {
            transfer_from_vault(&a.role_vault, &a.vault_token_account, &a.scout_token_account, &a.mint, &a.token_program, held)?;
            if a.task.reputable {
                a.scout_profile.advanced = a.scout_profile.advanced.checked_add(1).ok_or(ScoutError::Overflow)?;
                if let Some(op) = a.operator.as_deref_mut() {
                    op.advanced = op.advanced.checked_add(1).ok_or(ScoutError::Overflow)?;
                }
            }
            a.scout_profile.total_earned = a.scout_profile.total_earned.checked_add(held).ok_or(ScoutError::Overflow)?;
            a.role_vault.total_paid = a.role_vault.total_paid.checked_add(held).ok_or(ScoutError::Overflow)?;
            (held, 0)
        }
        Outcome::Fabricated => {
            let now = Clock::get()?.unix_timestamp;
            require!(now <= a.submission.holdback_deadline, ScoutError::HoldbackWindowExpired);
            transfer_from_vault(&a.role_vault, &a.vault_token_account, &a.company_token_account, &a.mint, &a.token_program, held)?;
            a.scout_profile.flagged = a.scout_profile.flagged.checked_add(1).ok_or(ScoutError::Overflow)?;
            if let Some(op) = a.operator.as_deref_mut() {
                op.flagged = op.flagged.checked_add(1).ok_or(ScoutError::Overflow)?;
            }
            (0, held)
        }
        Outcome::None => return err!(ScoutError::InvalidOutcome),
    };

    a.role_vault.held_back_total = a.role_vault.held_back_total.checked_sub(held).ok_or(ScoutError::Overflow)?;
    a.submission.holdback_amount = 0; // released or refunded exactly once: outcome is now set
    a.submission.outcome = outcome;
    a.vault_token_account.reload()?;
    crate::invariants::check_role(&a.role_vault, a.vault_token_account.amount)?;

    emit!(OutcomeAttested {
        role_vault: a.role_vault.key(),
        task: a.task.key(),
        submission: a.submission.key(),
        scout: a.submission.scout,
        operator: a.scout_profile.operator,
        outcome,
        reason_code,
        released,
        refunded,
    });
    Ok(())
}
