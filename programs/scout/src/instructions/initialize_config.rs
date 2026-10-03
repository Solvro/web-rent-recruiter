use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{constants::*, error::ScoutError, state::Config};

#[derive(Accounts)]
#[instruction(fee_bps: u16, treasury: Pubkey)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: any wallet may receive fees; it is pinned to the `treasury` argument.
    #[account(address = treasury)]
    pub treasury_wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_wallet,
        associated_token::token_program = token_program
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16, treasury: Pubkey) -> Result<()> {
    require!(u64::from(fee_bps) <= BPS_DENOMINATOR, ScoutError::InvalidFee);
    **ctx.accounts.config = Config {
        admin: ctx.accounts.admin.key(),
        treasury,
        treasury_token_account: ctx.accounts.treasury_token_account.key(),
        fee_bps,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        bump: ctx.bumps.config,
    };
    Ok(())
}
