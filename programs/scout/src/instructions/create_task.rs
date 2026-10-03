use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    error::ScoutError,
    events::TaskCreated,
    instructions::auth::require_company_or_agent,
    state::{RoleVault, Status, Task, TaskType},
};

#[derive(Accounts)]
#[instruction(task_id: u32)]
pub struct CreateTask<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The company or `role_vault.agent`.
    pub authority: Signer<'info>,
    #[account(mut, has_one = vault_token_account)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Task::INIT_SPACE,
        seeds = [TASK_SEED, role_vault.key().as_ref(), &task_id.to_le_bytes()],
        bump
    )]
    pub task: Box<Account<'info, Task>>,
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_create_task(
    ctx: Context<CreateTask>,
    task_id: u32,
    task_type: TaskType,
    bounty: u64,
    max_deliverables: u16,
    exclusive: bool,
    brief_hash: [u8; 32],
    holdback_bps: u16,
    subject_scout: Option<Pubkey>,
    min_accepted: u16,
    min_accept_rate_bps: u16,
    bond_bps: u16,
    confirmation_attestor: Option<Pubkey>,
) -> Result<()> {
    let a = ctx.accounts;
    let signer = a.authority.key();
    require_company_or_agent(&a.role_vault, &signer)?;
    require!(a.role_vault.status == Status::Open, ScoutError::RoleClosed);
    require!(task_id == a.role_vault.task_count, ScoutError::InvalidTaskId);
    require!(max_deliverables > 0, ScoutError::InvalidTaskParams);
    require!(bounty >= a.role_vault.min_bounty, ScoutError::BountyTooSmall);
    require!(holdback_bps <= MAX_HOLDBACK_BPS, ScoutError::InvalidHoldback);
    require!(bond_bps <= MAX_BOND_BPS, ScoutError::InvalidBond);
    require!(u64::from(min_accept_rate_bps) <= BPS_DENOMINATOR, ScoutError::InvalidTaskParams);

    // Soft cap: open tasks may not promise more than the vault holds beyond what is already owed.
    let capacity = bounty.checked_mul(u64::from(max_deliverables)).ok_or(ScoutError::Overflow)?;
    let open_capacity = a.role_vault.open_capacity.checked_add(capacity).ok_or(ScoutError::Overflow)?;
    let free = a
        .vault_token_account
        .amount
        .checked_sub(a.role_vault.held_back_total)
        .and_then(|v| v.checked_sub(a.role_vault.bonds_held))
        .ok_or(ScoutError::Overflow)?;
    require!(open_capacity <= free, ScoutError::OverCommitted);

    // The agent spends within the company's limits; the company itself is only bound by the budget.
    let created_by_agent = signer != a.role_vault.company;
    if created_by_agent {
        let committed = a.role_vault.agent_committed.checked_add(capacity).ok_or(ScoutError::Overflow)?;
        require!(
            bounty <= a.role_vault.agent_max_bounty && committed <= a.role_vault.agent_max_commitment,
            ScoutError::AgentCapExceeded
        );
        a.role_vault.agent_committed = committed;
    }

    **a.task = Task {
        role_vault: a.role_vault.key(),
        task_id,
        task_type,
        bounty,
        max_deliverables,
        accepted_count: 0,
        pending_count: 0,
        exclusive,
        claimant: None,
        claimed_at: 0,
        brief_hash,
        holdback_bps,
        subject_scout,
        min_accepted,
        min_accept_rate_bps,
        confirmation_attestor,
        created_by_agent,
        reputable: bounty >= a.role_vault.min_reputable_bounty,
        bond_bps,
        status: Status::Open,
        bump: ctx.bumps.task,
    };
    let role = &mut a.role_vault;
    role.open_capacity = open_capacity;
    role.task_count = role.task_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    role.open_task_count = role.open_task_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    crate::invariants::check_role(role, a.vault_token_account.amount)?;

    emit!(TaskCreated {
        role_vault: role.key(),
        task: a.task.key(),
        task_id,
        task_type,
        bounty,
        max_deliverables,
        exclusive,
        brief_hash,
        holdback_bps,
        subject_scout,
        min_accepted,
        min_accept_rate_bps,
        bond_bps,
        confirmation_attestor,
        created_by: a.authority.key(),
    });
    Ok(())
}
