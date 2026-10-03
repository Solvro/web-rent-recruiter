use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::ScoutError,
    events::SubmissionAccepted,
    state::{RoleVault, ScoutProfile, Submission, SubmissionStatus},
};

/// Shared by `accept_submission` and `settle_expired`: pays `bounty - fee` to the
/// scout and `fee` to the treasury from the program-owned vault, in one instruction.
#[allow(clippy::too_many_arguments)]
pub fn pay_out<'info>(
    role: &mut Account<'info, RoleVault>,
    submission: &mut Account<'info, Submission>,
    profile: &mut Account<'info, ScoutProfile>,
    vault_token_account: &InterfaceAccount<'info, TokenAccount>,
    scout_token_account: &InterfaceAccount<'info, TokenAccount>,
    treasury_token_account: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    auto_settled: bool,
) -> Result<()> {
    require!(submission.status == SubmissionStatus::Pending, ScoutError::NotPending);

    let bounty = role.bounty_per_candidate;
    let fee = u64::try_from(
        u128::from(bounty)
            .checked_mul(u128::from(role.fee_bps))
            .ok_or(ScoutError::Overflow)?
            / u128::from(BPS_DENOMINATOR),
    )
    .map_err(|_| ScoutError::Overflow)?;
    let payout = bounty.checked_sub(fee).ok_or(ScoutError::Overflow)?;

    let role_id = role.role_id.to_le_bytes();
    let seeds: &[&[u8]] = &[ROLE_SEED, role.company.as_ref(), &role_id, &[role.bump]];
    let signer = &[seeds];

    for (to, amount) in [(scout_token_account, payout), (treasury_token_account, fee)] {
        if amount == 0 {
            continue;
        }
        let cpi_accounts = TransferChecked {
            from: vault_token_account.to_account_info(),
            to: to.to_account_info(),
            authority: role.to_account_info(),
            mint: mint.to_account_info(),
        };
        transfer_checked(
            CpiContext::new_with_signer(token_program.key(), cpi_accounts, signer),
            amount,
            mint.decimals,
        )?;
    }

    submission.status = SubmissionStatus::Accepted;
    role.pending_count = role.pending_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    role.accepted_count = role.accepted_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    role.total_paid = role.total_paid.checked_add(bounty).ok_or(ScoutError::Overflow)?;
    profile.accepted = profile.accepted.checked_add(1).ok_or(ScoutError::Overflow)?;
    profile.total_earned = profile.total_earned.checked_add(payout).ok_or(ScoutError::Overflow)?;

    emit!(SubmissionAccepted {
        role_vault: role.key(),
        submission: submission.key(),
        scout: submission.scout,
        payout,
        fee,
        auto_settled,
    });
    Ok(())
}
