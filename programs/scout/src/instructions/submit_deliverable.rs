use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::ScoutError,
    events::DeliverableSubmitted,
    math::bond_of,
    state::{Outcome, RoleVault, ScoutProfile, Status, Submission, SubmissionStatus, Task, TaskType},
};

#[derive(Accounts)]
#[instruction(deliverable_hash: [u8; 32])]
pub struct SubmitDeliverable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub scout: Signer<'info>,
    /// A gatekeeper (`role.agent` or the company) co-signs: a scout alone can't put deliverables or
    /// claims on-chain, and no single agent implementation is required.
    #[account(constraint = role_vault.is_gatekeeper(&gatekeeper.key()) @ ScoutError::NotGatekeeper)]
    pub gatekeeper: Signer<'info>,
    #[account(mut, has_one = vault_token_account, has_one = mint)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        mut,
        seeds = [TASK_SEED, role_vault.key().as_ref(), &task.task_id.to_le_bytes()],
        bump = task.bump,
        has_one = role_vault
    )]
    pub task: Box<Account<'info, Task>>,
    #[account(mut, seeds = [SCOUT_SEED, scout.key().as_ref()], bump = scout_profile.bump, has_one = scout)]
    pub scout_profile: Box<Account<'info, ScoutProfile>>,
    /// Unique per (task, deliverable): a duplicate fails here and the first scout keeps the credit.
    #[account(
        init,
        payer = payer,
        space = 8 + Submission::INIT_SPACE,
        seeds = [SUBMISSION_SEED, task.key().as_ref(), deliverable_hash.as_ref()],
        bump
    )]
    pub submission: Box<Account<'info, Submission>>,
    #[account(mut)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Source of the deliverable bond (only debited when the task has one and the scout has no operator).
    #[account(
        mut,
        constraint = scout_token_account.owner == scout.key() @ ScoutError::InvalidTokenAccount,
        constraint = scout_token_account.mint == mint.key() @ ScoutError::InvalidTokenAccount
    )]
    pub scout_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_submit_deliverable(
    ctx: Context<SubmitDeliverable>,
    deliverable_hash: [u8; 32],
    evidence_hash: [u8; 32],
) -> Result<()> {
    let a = ctx.accounts;
    let scout = a.scout.key();
    let role = &mut a.role_vault;
    let task = &mut a.task;
    require!(role.status == Status::Open, ScoutError::RoleClosed);
    require!(task.status == Status::Open, ScoutError::TaskClosed);
    // Neither side of the budget may deliver to it: the agent can't pay itself (or the company).
    require!(scout != role.company && role.agent != Some(scout), ScoutError::SelfDealing);
    if task.exclusive {
        require!(task.claimant == Some(scout), ScoutError::NotClaimant);
    }
    // Same gates as claim_task, so non-exclusive tasks can't bypass them (defence in depth).
    require!(task.subject_scout != Some(scout), ScoutError::SelfReview);
    require!(task.reputation_ok(&a.scout_profile), ScoutError::ReputationTooLow);
    if task.task_type != TaskType::Sourcing {
        require!(evidence_hash != [0u8; 32], ScoutError::MissingEvidence);
    }
    require!(
        u32::from(task.accepted_count) + u32::from(task.pending_count) < u32::from(task.max_deliverables),
        ScoutError::TaskFull
    );

    // Role-level funded invariant: every pending deliverable (across all tasks) plus every
    // held-back payout and posted bond must be covered by the vault, so a scout never works for
    // unfunded money.
    let pending_value = role.pending_value.checked_add(task.bounty).ok_or(ScoutError::Overflow)?;
    let needed = pending_value
        .checked_add(role.held_back_total)
        .and_then(|v| v.checked_add(role.bonds_held))
        .ok_or(ScoutError::Overflow)?;
    require!(a.vault_token_account.amount >= needed, ScoutError::InsufficientBudget);

    // Skin in the game: scouts without an operator vouching for them post a small bond.
    let bond = if a.scout_profile.operator.is_none() {
        bond_of(task.bounty, task.bond_bps).ok_or(ScoutError::InvalidBond)?
    } else {
        0
    };
    if bond > 0 {
        let cpi_accounts = TransferChecked {
            from: a.scout_token_account.to_account_info(),
            to: a.vault_token_account.to_account_info(),
            authority: a.scout.to_account_info(),
            mint: a.mint.to_account_info(),
        };
        transfer_checked(CpiContext::new(a.token_program.key(), cpi_accounts), bond, a.mint.decimals)?;
        role.bonds_held = role.bonds_held.checked_add(bond).ok_or(ScoutError::Overflow)?;
    }

    let now = Clock::get()?.unix_timestamp;
    let review_deadline = now.checked_add(role.review_window_seconds).ok_or(ScoutError::Overflow)?;
    **a.submission = Submission {
        role_vault: role.key(),
        task: task.key(),
        scout,
        deliverable_hash,
        evidence_hash,
        submitted_at: now,
        review_deadline,
        status: SubmissionStatus::Pending,
        reject_reason: NO_REJECT_REASON,
        holdback_amount: 0,
        rent_payer: a.payer.key(),
        bond_amount: bond,
        holdback_deadline: 0,
        outcome: Outcome::None,
        review_hash: [0u8; 32],
        bump: ctx.bumps.submission,
    };

    role.pending_value = pending_value;
    role.pending_count = role.pending_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    task.pending_count = task.pending_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    if task.reputable {
        a.scout_profile.submitted = a.scout_profile.submitted.checked_add(1).ok_or(ScoutError::Overflow)?;
    }
    a.vault_token_account.reload()?;
    crate::invariants::check_role(role, a.vault_token_account.amount)?;
    crate::invariants::check_task(task)?;

    emit!(DeliverableSubmitted {
        role_vault: role.key(),
        task: task.key(),
        submission: a.submission.key(),
        scout: a.scout.key(),
        deliverable_hash,
        evidence_hash,
        bond,
        review_deadline,
    });
    Ok(())
}
