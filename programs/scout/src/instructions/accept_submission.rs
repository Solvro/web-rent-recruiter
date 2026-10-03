use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::ScoutError,
    instructions::payout::pay_out,
    state::{Config, RoleVault, ScoutProfile, Submission},
};

#[derive(Accounts)]
pub struct AcceptSubmission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The company, or the delegated agent if the role has one.
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury_token_account)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, has_one = mint, has_one = vault_token_account)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        mut,
        seeds = [SUBMISSION_SEED, role_vault.key().as_ref(), submission.candidate_hash.as_ref()],
        bump = submission.bump,
        has_one = role_vault
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
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_accept_submission(ctx: Context<AcceptSubmission>) -> Result<()> {
    let a = ctx.accounts;
    let signer = a.authority.key();
    require!(
        signer == a.role_vault.company || a.role_vault.agent == Some(signer),
        ScoutError::Unauthorized
    );
    pay_out(
        &mut a.role_vault,
        &mut a.submission,
        &mut a.scout_profile,
        &a.vault_token_account,
        &a.scout_token_account,
        &a.treasury_token_account,
        &a.mint,
        &a.token_program,
        false,
    )
}
