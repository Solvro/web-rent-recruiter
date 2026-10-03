use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::ScoutError,
    events::OperatorRegistered,
    state::{Config, Operator},
};

#[derive(Accounts)]
pub struct RegisterOperator<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Operator::INIT_SPACE,
        seeds = [OPERATOR_SEED, authority.key().as_ref()],
        bump
    )]
    pub operator: Box<Account<'info, Operator>>,
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program
    )]
    pub operator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_operator(ctx: Context<RegisterOperator>, fee_bps: u16, name: String) -> Result<()> {
    require!(fee_bps <= MAX_OPERATOR_FEE_BPS, ScoutError::InvalidOperatorFee);
    require!(!name.is_empty() && name.len() <= MAX_OPERATOR_NAME_LEN, ScoutError::InvalidOperatorName);
    let a = ctx.accounts;
    **a.operator = Operator {
        authority: a.authority.key(),
        name: name.clone(),
        fee_bps,
        token_account: a.operator_token_account.key(),
        recruiters: 0,
        accepted: 0,
        advanced: 0,
        flagged: 0,
        bump: ctx.bumps.operator,
    };
    emit!(OperatorRegistered {
        operator: a.operator.key(),
        authority: a.authority.key(),
        name,
        fee_bps,
    });
    Ok(())
}
