use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    state::{Config, ScoutProfile},
};

#[derive(Accounts)]
pub struct RegisterScout<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub scout: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ScoutProfile::INIT_SPACE,
        seeds = [SCOUT_SEED, scout.key().as_ref()],
        bump
    )]
    pub scout_profile: Box<Account<'info, ScoutProfile>>,
    /// Created up front so payouts never have to create accounts.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = scout,
        associated_token::token_program = token_program
    )]
    pub scout_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_scout(ctx: Context<RegisterScout>) -> Result<()> {
    **ctx.accounts.scout_profile = ScoutProfile {
        scout: ctx.accounts.scout.key(),
        submitted: 0,
        accepted: 0,
        rejected: 0,
        total_earned: 0,
        bump: ctx.bumps.scout_profile,
    };
    Ok(())
}
