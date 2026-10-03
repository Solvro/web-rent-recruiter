use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ScoutError,
    events::{ClaimReleased, TaskClaimed},
    state::{RoleVault, ScoutProfile, Status, Task},
};

#[derive(Accounts)]
pub struct ClaimTask<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub scout: Signer<'info>,
    /// A gatekeeper (`role.agent` or the company) co-signs: a scout alone can't put deliverables or
    /// claims on-chain, and no single agent implementation is required.
    #[account(constraint = role_vault.is_gatekeeper(&gatekeeper.key()) @ ScoutError::NotGatekeeper)]
    pub gatekeeper: Signer<'info>,
    #[account(seeds = [SCOUT_SEED, scout.key().as_ref()], bump = scout_profile.bump, has_one = scout)]
    pub scout_profile: Box<Account<'info, ScoutProfile>>,
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        mut,
        seeds = [TASK_SEED, role_vault.key().as_ref(), &task.task_id.to_le_bytes()],
        bump = task.bump,
        has_one = role_vault
    )]
    pub task: Box<Account<'info, Task>>,
}

/// Exclusive gigs (one screening call, one reference check) have a single claimant.
pub fn handle_claim_task(ctx: Context<ClaimTask>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.role_vault.status == Status::Open, ScoutError::RoleClosed);
    let task = &mut a.task;
    require!(task.status == Status::Open, ScoutError::TaskClosed);
    require!(task.exclusive, ScoutError::NotExclusive);
    require!(task.claimant.is_none(), ScoutError::AlreadyClaimed);
    require!(task.subject_scout != Some(a.scout.key()), ScoutError::SelfReview);
    require!(task.reputation_ok(&a.scout_profile), ScoutError::ReputationTooLow);
    require!(
        u32::from(task.accepted_count) + u32::from(task.pending_count) < u32::from(task.max_deliverables),
        ScoutError::TaskFull
    );
    task.claimant = Some(a.scout.key());
    task.claimed_at = Clock::get()?.unix_timestamp;
    emit!(TaskClaimed { role_vault: a.role_vault.key(), task: task.key(), scout: a.scout.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseClaim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The claimant (any time), or the company/agent once the claim timed out with nothing pending.
    pub authority: Signer<'info>,
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        mut,
        seeds = [TASK_SEED, role_vault.key().as_ref(), &task.task_id.to_le_bytes()],
        bump = task.bump,
        has_one = role_vault
    )]
    pub task: Box<Account<'info, Task>>,
}

pub fn handle_release_claim(ctx: Context<ReleaseClaim>) -> Result<()> {
    let a = ctx.accounts;
    let task = &mut a.task;
    let claimant = task.claimant.ok_or(ScoutError::NotClaimed)?;
    let signer = a.authority.key();
    if signer != claimant {
        crate::instructions::auth::require_company_or_agent(&a.role_vault, &signer)?;
        require!(task.pending_count == 0, ScoutError::PendingSubmissions);
        let now = Clock::get()?.unix_timestamp;
        let expires = task
            .claimed_at
            .checked_add(a.role_vault.claim_timeout_seconds)
            .ok_or(ScoutError::Overflow)?;
        require!(now > expires, ScoutError::ClaimTimeoutOpen);
    }
    task.claimant = None;
    task.claimed_at = 0;
    emit!(ClaimReleased {
        role_vault: a.role_vault.key(),
        task: task.key(),
        scout: claimant,
        released_by: signer,
    });
    Ok(())
}
