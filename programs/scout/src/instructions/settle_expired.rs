use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ScoutError,
    instructions::payout::pay_out,
    state::{Config, Operator, RoleVault, ScoutProfile, Submission, Task, TaskType},
};

#[derive(Accounts)]
pub struct SettleExpired<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// SOURCING only: the task's confirmation attestor (default `role.agent`) or the company, so an
    /// unconfirmed candidate can't be auto-paid. Other task types settle permissionlessly.
    pub attestor: Option<Signer<'info>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_token_account)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = mint, has_one = vault_token_account)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        mut,
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
    #[account(mut)]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The scout's vouching operator and its fee account; omit both if the scout has none.
    #[account(mut)]
    pub operator: Option<Box<Account<'info, Operator>>>,
    #[account(mut)]
    pub operator_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless: once the review window has passed, silence counts as acceptance.
pub fn handle_settle_expired(ctx: Context<SettleExpired>) -> Result<()> {
    let a = ctx.accounts;
    let now = Clock::get()?.unix_timestamp;
    require!(now > a.submission.review_deadline, ScoutError::ReviewWindowOpen);
    if a.task.task_type == TaskType::Sourcing {
        let attestor = a.attestor.as_ref().map(|s| s.key()).ok_or(ScoutError::NotAttestor)?;
        let designated = a.task.confirmation_attestor.or(a.role_vault.agent);
        require!(
            attestor == a.role_vault.company || Some(attestor) == designated,
            ScoutError::NotAttestor
        );
    }
    let payer = a.payer.key();
    pay_out(
        &mut a.role_vault,
        &mut a.task,
        &mut a.submission,
        &mut a.scout_profile,
        &a.vault_token_account,
        &a.scout_token_account,
        &a.treasury_token_account,
        a.operator.as_deref_mut(),
        a.operator_token_account.as_deref(),
        &a.mint,
        &a.token_program,
        true,
        payer,
        [0u8; 32],
    )?;
    a.vault_token_account.reload()?;
    crate::invariants::check_role(&a.role_vault, a.vault_token_account.amount)?;
    crate::invariants::check_task(&a.task)
}
