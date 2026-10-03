use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::*,
    error::ScoutError,
    events::RoleClosed,
    state::{Status, RoleVault},
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
    require!(a.role_vault.status == Status::Open, ScoutError::RoleClosed);
    // Close every task first (close_task); then nothing new can be promised.
    require!(a.role_vault.open_task_count == 0, ScoutError::OpenTasks);
    // Pending submissions are funded promises to scouts; settle them before withdrawing.
    require!(a.role_vault.pending_count == 0, ScoutError::PendingSubmissions);
    // Holdbacks belong to scouts (or go back via attest_outcome); release or attest them first.
    require!(a.role_vault.held_back_total == 0, ScoutError::HoldbackOutstanding);

    // Sweep everything, including anything sent to the vault directly, then close the vault token
    // account itself so no tokens or rent stay behind. Rent goes back to the payer that funded it.
    let refunded = a.vault_token_account.amount;
    let role = &a.role_vault;
    let role_id = role.role_id.to_le_bytes();
    let seeds: &[&[u8]] = &[ROLE_SEED, role.company.as_ref(), &role_id, &[role.bump]];
    if refunded > 0 {
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
    let close_accounts = CloseAccount {
        account: a.vault_token_account.to_account_info(),
        destination: a.payer.to_account_info(),
        authority: role.to_account_info(),
    };
    close_account(CpiContext::new_with_signer(a.token_program.key(), close_accounts, &[seeds]))?;

    a.role_vault.status = Status::Closed;
    emit!(RoleClosed { role_vault: a.role_vault.key(), refunded });
    Ok(())
}
