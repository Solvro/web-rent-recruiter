use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::ScoutError,
    state::{Config, ConfigParams},
};

const BPF_LOADER_UPGRADEABLE_ID: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// `UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }` (bincode):
/// u32 variant tag (3), u64 slot, u8 Option tag, then the 32-byte authority.
fn upgrade_authority(program_data: &AccountInfo) -> Option<Pubkey> {
    let data = program_data.try_borrow_data().ok()?;
    if data.len() < 45 || data[0..4] != 3u32.to_le_bytes() || data[12] != 1 {
        return None;
    }
    Some(Pubkey::new_from_array(data[13..45].try_into().ok()?))
}

#[derive(Accounts)]
#[instruction(treasury: Pubkey)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Must be the program's upgrade authority, so nobody can front-run the one-time init after deploy.
    pub admin: Signer<'info>,
    /// CHECK: this program's ProgramData account (address derived below), read in the handler.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = BPF_LOADER_UPGRADEABLE_ID,
        owner = BPF_LOADER_UPGRADEABLE_ID
    )]
    pub program_data: UncheckedAccount<'info>,
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

pub fn handle_initialize_config(ctx: Context<InitializeConfig>, treasury: Pubkey, params: ConfigParams) -> Result<()> {
    require!(
        upgrade_authority(&ctx.accounts.program_data) == Some(ctx.accounts.admin.key()),
        ScoutError::NotUpgradeAuthority
    );
    require!(params.is_valid(), ScoutError::InvalidConfig);
    **ctx.accounts.config = Config {
        admin: ctx.accounts.admin.key(),
        treasury,
        treasury_token_account: ctx.accounts.treasury_token_account.key(),
        fee_bps: params.fee_bps,
        usdc_mint: ctx.accounts.usdc_mint.key(),
        min_bounty: params.min_bounty,
        min_reputable_bounty: params.min_reputable_bounty,
        min_window_seconds: params.min_window_seconds,
        max_window_seconds: params.max_window_seconds,
        bump: ctx.bumps.config,
    };
    Ok(())
}
