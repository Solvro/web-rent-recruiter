use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::ScoutError,
    events::RoleClosed,
    state::{RoleStatus, RoleVault},
};

#[derive(Accounts)]
pub struct CloseRole<'info> {
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

pub fn handle_close_role(ctx: Context<CloseRole>) -> Result<()> {
    let a = ctx.accounts;
    require!(a.role_vault.status == RoleStatus::Open, ScoutError::RoleClosed);
    // Pending submissions are funded promises to scouts; settle them before withdrawing.
    require!(a.role_vault.pending_count == 0, ScoutError::PendingSubmissions);

    let refunded = a.vault_token_account.amount;
    if refunded > 0 {
        let role = &a.role_vault;
        let role_id = role.role_id.to_le_bytes();
        let seeds: &[&[u8]] = &[ROLE_SEED, role.company.as_ref(), &role_id, &[role.bump]];
        let cpi_accounts = TransferChecked {
            from: a.vault_token_account.to_account_info(),
            to: a.company_token_account.to_account_info(),
            authority: role.to_account_info(),
            mint: a.mint.to_account_info(),
        };
        transfer_checked(
            CpiContext::new_with_signer(a.token_program.key(), cpi_accounts, &[seeds]),
            refunded,
            a.mint.decimals,
        )?;
    }

    a.role_vault.status = RoleStatus::Closed;
    emit!(RoleClosed { role_vault: a.role_vault.key(), refunded });
    Ok(())
}
