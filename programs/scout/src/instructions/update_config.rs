use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::ScoutError,
    events::ConfigUpdated,
    state::{Config, ConfigParams},
};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the (possibly new) treasury wallet; its USDC ATA receives platform fees.
    pub treasury_wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = treasury_wallet,
        associated_token::token_program = token_program
    )]
    pub treasury_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Admin-only: rotate the treasury and adjust fee/bounds within the hard limits. Open roles keep
/// the fee and minimums they snapshotted at creation; only new roles see the change. The mint and
/// the admin can't be changed.
pub fn handle_update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
    require!(params.is_valid(), ScoutError::InvalidConfig);
    let a = ctx.accounts;
    let config = &mut a.config;
    config.treasury = a.treasury_wallet.key();
    config.treasury_token_account = a.treasury_token_account.key();
    config.fee_bps = params.fee_bps;
    config.min_bounty = params.min_bounty;
    config.min_reputable_bounty = params.min_reputable_bounty;
    config.min_window_seconds = params.min_window_seconds;
    config.max_window_seconds = params.max_window_seconds;
    emit!(ConfigUpdated {
        treasury: config.treasury,
        fee_bps: params.fee_bps,
        min_bounty: params.min_bounty,
        min_reputable_bounty: params.min_reputable_bounty,
        min_window_seconds: params.min_window_seconds,
        max_window_seconds: params.max_window_seconds,
    });
    Ok(())
}
