use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    error::ScoutError,
    events::RoleToppedUp,
    state::{Status, RoleVault},
};

#[derive(Accounts)]
pub struct TopUp<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub company: Signer<'info>,
    #[account(mut, has_one = company, has_one = mint, has_one = vault_token_account)]
    pub role_vault: Box<Account<'info, RoleVault>>,
    #[account(mut)]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = company,
        token::token_program = token_program
    )]
    pub company_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
    require!(amount > 0, ScoutError::InvalidAmount);
    let accounts = ctx.accounts;
    require!(accounts.role_vault.status == Status::Open, ScoutError::RoleClosed);

    let cpi_accounts = TransferChecked {
        from: accounts.company_token_account.to_account_info(),
        to: accounts.vault_token_account.to_account_info(),
        authority: accounts.company.to_account_info(),
        mint: accounts.mint.to_account_info(),
    };
    transfer_checked(
        CpiContext::new(accounts.token_program.key(), cpi_accounts),
        amount,
        accounts.mint.decimals,
    )?;

    let role = &mut accounts.role_vault;
    role.total_deposited = role.total_deposited.checked_add(amount).ok_or(ScoutError::Overflow)?;
    emit!(RoleToppedUp {
        role_vault: role.key(),
        amount,
        total_deposited: role.total_deposited,
    });
    Ok(())
}
