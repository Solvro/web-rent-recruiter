use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ScoutError,
    instructions::payout::pay_out,
    state::{Config, Operator, RoleVault, ScoutProfile, Submission, Task},
};

#[derive(Accounts)]
pub struct AcceptSubmission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The company or `role_vault.agent`.
    pub authority: Signer<'info>,
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

/// The agent (or company) accepts a deliverable: the scout is paid instantly from the vault.
pub fn handle_accept_submission(ctx: Context<AcceptSubmission>, review_hash: [u8; 32]) -> Result<()> {
    let a = ctx.accounts;
    let signer = a.authority.key();
    crate::instructions::auth::require_company_or_agent(&a.role_vault, &signer)?;
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
        false,
        signer,
        review_hash,
    )?;
    a.vault_token_account.reload()?;
    crate::invariants::check_role(&a.role_vault, a.vault_token_account.amount)?;
    crate::invariants::check_task(&a.task)
}
