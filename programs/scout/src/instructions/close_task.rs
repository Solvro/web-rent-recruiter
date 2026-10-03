use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ScoutError,
    events::TaskClosed,
    instructions::auth::require_company_or_agent,
    state::{RoleVault, Status, Task},
};

#[derive(Accounts)]
pub struct CloseTask<'info> {
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
}

/// Stops a gig. Pending deliverables must be decided (or settled) first; holdbacks stay with the role.
pub fn handle_close_task(ctx: Context<CloseTask>) -> Result<()> {
    let a = ctx.accounts;
    require_company_or_agent(&a.role_vault, &a.authority.key())?;
    let task = &mut a.task;
    require!(task.status == Status::Open, ScoutError::TaskClosed);
    require!(task.pending_count == 0, ScoutError::PendingSubmissions);

    // accepted_count <= max_deliverables always (submit caps accepted + pending at max).
    let unused = u64::from(task.max_deliverables.checked_sub(task.accepted_count).ok_or(ScoutError::Overflow)?)
        .checked_mul(task.bounty)
        .ok_or(ScoutError::Overflow)?;
    let role = &mut a.role_vault;
    role.open_capacity = role.open_capacity.checked_sub(unused).ok_or(ScoutError::Overflow)?;
    if task.created_by_agent {
        // Unused slots of an agent task were never spent: give them back to the agent's allowance.
        role.agent_committed = role.agent_committed.checked_sub(unused).ok_or(ScoutError::Overflow)?;
    }
    role.open_task_count = role.open_task_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    task.status = Status::Closed;

    emit!(TaskClosed { role_vault: role.key(), task: task.key(), accepted: task.accepted_count });
    Ok(())
}
