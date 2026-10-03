use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::*,
    error::ScoutError,
    events::ScoutRegistered,
    state::{Config, Operator, ScoutProfile},
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
    /// Optional: the operator vouching for this scout. Requires `operator_authority` to co-sign.
    #[account(mut, seeds = [OPERATOR_SEED, operator.authority.as_ref()], bump = operator.bump)]
    pub operator: Option<Box<Account<'info, Operator>>>,
    pub operator_authority: Option<Signer<'info>>,
    #[account(address = config.usdc_mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_scout(ctx: Context<RegisterScout>) -> Result<()> {
    let a = ctx.accounts;
    let operator = match (a.operator.as_deref_mut(), a.operator_authority.as_ref()) {
        (Some(op), Some(auth)) => {
            require_keys_eq!(op.authority, auth.key(), ScoutError::OperatorSignatureRequired);
            op.recruiters = op.recruiters.checked_add(1).ok_or(ScoutError::Overflow)?;
            Some(op.key())
        }
        (None, None) => None,
        _ => return err!(ScoutError::OperatorSignatureRequired),
    };
    **a.scout_profile = ScoutProfile {
        scout: a.scout.key(),
        submitted: 0,
        accepted: 0,
        rejected: 0,
        sourcing_accepted: 0,
        screening_accepted: 0,
        reference_accepted: 0,
        advanced: 0,
        flagged: 0,
        total_earned: 0,
        operator,
        bump: ctx.bumps.scout_profile,
    };
    emit!(ScoutRegistered {
        scout: a.scout.key(),
        scout_profile: a.scout_profile.key(),
        operator,
    });
    Ok(())
}
