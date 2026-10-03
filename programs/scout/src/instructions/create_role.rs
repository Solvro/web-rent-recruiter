use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::*,
    error::ScoutError,
    events::RoleCreated,
    state::{Config, RoleVault, Status},
};

#[derive(Accounts)]
#[instruction(role_id: u64)]
pub struct CreateRole<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub company: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = payer,
        space = 8 + RoleVault::INIT_SPACE,
        seeds = [ROLE_SEED, company.key().as_ref(), &role_id.to_le_bytes()],
        bump
    )]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = role_vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = company,
        token::token_program = token_program
    )]
    pub company_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_create_role(
    ctx: Context<CreateRole>,
    role_id: u64,
    agent: Option<Pubkey>,
    review_window_seconds: i64,
    claim_timeout_seconds: i64,
    holdback_window_seconds: i64,
    initial_deposit: u64,
    agent_max_bounty: u64,
    agent_max_commitment: u64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let config = &accounts.config;
    require!(
        config.window_ok(review_window_seconds)
            && config.window_ok(claim_timeout_seconds)
            && config.window_ok(holdback_window_seconds),
        ScoutError::WindowOutOfRange
    );

    **accounts.role_vault = RoleVault {
        company: accounts.company.key(),
        role_id,
        mint: accounts.mint.key(),
        vault_token_account: accounts.vault_token_account.key(),
        agent,
        fee_bps: config.fee_bps,
        min_bounty: config.min_bounty,
        min_reputable_bounty: config.min_reputable_bounty,
        agent_max_bounty,
        agent_max_commitment,
        agent_committed: 0,
        review_window_seconds,
        claim_timeout_seconds,
        holdback_window_seconds,
        task_count: 0,
        open_task_count: 0,
        accepted_count: 0,
        pending_count: 0,
        pending_value: 0,
        open_capacity: 0,
        held_back_total: 0,
        bonds_held: 0,
        total_deposited: initial_deposit,
        total_paid: 0,
        status: Status::Open,
        bump: ctx.bumps.role_vault,
    };

    if initial_deposit > 0 {
        let cpi_accounts = TransferChecked {
            from: accounts.company_token_account.to_account_info(),
            to: accounts.vault_token_account.to_account_info(),
            authority: accounts.company.to_account_info(),
            mint: accounts.mint.to_account_info(),
        };
        transfer_checked(
            CpiContext::new(accounts.token_program.key(), cpi_accounts),
            initial_deposit,
            accounts.mint.decimals,
        )?;
    }

    emit!(RoleCreated {
        role_vault: accounts.role_vault.key(),
        company: accounts.company.key(),
        role_id,
        agent,
        initial_deposit,
    });
    Ok(())
}
