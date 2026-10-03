use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    constants::*,
    error::ScoutError,
    events::SubmissionAccepted,
    math::{split, Split},
    state::{Operator, RoleVault, ScoutProfile, Submission, SubmissionStatus, Task, TaskType},
};


/// Transfers `amount` out of the role's program-owned vault, signed by the RoleVault PDA.
pub fn transfer_from_vault<'info>(
    role: &Account<'info, RoleVault>,
    vault_token_account: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let role_id = role.role_id.to_le_bytes();
    let seeds: &[&[u8]] = &[ROLE_SEED, role.company.as_ref(), &role_id, &[role.bump]];
    let cpi_accounts = TransferChecked {
        from: vault_token_account.to_account_info(),
        to: to.to_account_info(),
        authority: role.to_account_info(),
        mint: mint.to_account_info(),
    };
    transfer_checked(
        CpiContext::new_with_signer(token_program.key(), cpi_accounts, &[seeds]),
        amount,
        mint.decimals,
    )
}

/// Checks that the operator accounts passed in match the scout's vouching operator.
pub fn check_operator(
    profile: &ScoutProfile,
    operator: Option<&Account<Operator>>,
    operator_token_account: Option<&InterfaceAccount<TokenAccount>>,
) -> Result<()> {
    require!(operator.map(|o| o.key()) == profile.operator, ScoutError::OperatorMismatch);
    if let Some(op) = operator {
        require!(
            operator_token_account.map(|t| t.key()) == Some(op.token_account),
            ScoutError::OperatorMismatch
        );
    }
    Ok(())
}

/// Shared by `accept_submission` and `settle_expired`. The company pays exactly `task.bounty`:
/// - `fee = bounty * role.fee_bps` goes to the treasury now;
/// - `operator_fee = (bounty - fee) * operator.fee_bps` goes to the vouching operator now (if any);
/// - the scout's share `bounty - fee - operator_fee` is split into
///   `holdback = share * task.holdback_bps` (parked in the vault) and the rest, paid to the scout now.
#[allow(clippy::too_many_arguments)]
pub fn pay_out<'info>(
    role: &mut Account<'info, RoleVault>,
    task: &mut Account<'info, Task>,
    submission: &mut Account<'info, Submission>,
    profile: &mut Account<'info, ScoutProfile>,
    vault_token_account: &InterfaceAccount<'info, TokenAccount>,
    scout_token_account: &InterfaceAccount<'info, TokenAccount>,
    treasury_token_account: &InterfaceAccount<'info, TokenAccount>,
    mut operator: Option<&mut Account<'info, Operator>>,
    operator_token_account: Option<&InterfaceAccount<'info, TokenAccount>>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    auto_settled: bool,
    accepted_by: Pubkey,
    review_hash: [u8; 32],
) -> Result<()> {
    require!(submission.status == SubmissionStatus::Pending, ScoutError::NotPending);
    check_operator(profile, operator.as_deref(), operator_token_account)?;

    // Exact split, floors everywhere, dust to the scout: fee + operator_fee + held_back + payout == bounty.
    let bounty = task.bounty;
    let operator_bps = operator.as_deref().map_or(0, |op| op.fee_bps);
    let Split { fee, operator_fee, held_back, payout } =
        split(bounty, role.fee_bps, operator_bps, task.holdback_bps).ok_or(ScoutError::Overflow)?;

    transfer_from_vault(role, vault_token_account, scout_token_account, mint, token_program, payout)?;
    transfer_from_vault(role, vault_token_account, treasury_token_account, mint, token_program, fee)?;
    // The scout's bond (if any) comes back whole; it was never part of the budget.
    let bond = submission.bond_amount;
    transfer_from_vault(role, vault_token_account, scout_token_account, mint, token_program, bond)?;
    role.bonds_held = role.bonds_held.checked_sub(bond).ok_or(ScoutError::Overflow)?;
    if let (Some(op), Some(op_token)) = (operator.as_deref_mut(), operator_token_account) {
        transfer_from_vault(role, vault_token_account, op_token, mint, token_program, operator_fee)?;
        if task.reputable {
            op.accepted = op.accepted.checked_add(1).ok_or(ScoutError::Overflow)?;
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let holdback_deadline = now.checked_add(role.holdback_window_seconds).ok_or(ScoutError::Overflow)?;
    submission.status = SubmissionStatus::Accepted;
    submission.holdback_amount = held_back;
    submission.holdback_deadline = holdback_deadline;
    submission.review_hash = review_hash;

    task.pending_count = task.pending_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    task.accepted_count = task.accepted_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    role.pending_count = role.pending_count.checked_sub(1).ok_or(ScoutError::Overflow)?;
    role.pending_value = role.pending_value.checked_sub(bounty).ok_or(ScoutError::Overflow)?;
    // The accepted slot is no longer a promise: free budget and commitments both drop by exactly `bounty`.
    role.open_capacity = role.open_capacity.checked_sub(bounty).ok_or(ScoutError::Overflow)?;
    role.accepted_count = role.accepted_count.checked_add(1).ok_or(ScoutError::Overflow)?;
    let paid_now = payout.checked_add(fee).and_then(|v| v.checked_add(operator_fee)).ok_or(ScoutError::Overflow)?;
    role.total_paid = role.total_paid.checked_add(paid_now).ok_or(ScoutError::Overflow)?;
    role.held_back_total = role.held_back_total.checked_add(held_back).ok_or(ScoutError::Overflow)?;

    // Reputation only from tasks worth at least `min_reputable_bounty`: farming accepted counts with
    // dust-sized gigs between colluding wallets costs real money per point.
    if task.reputable {
        profile.accepted = profile.accepted.checked_add(1).ok_or(ScoutError::Overflow)?;
        let per_type = match task.task_type {
            TaskType::Sourcing => &mut profile.sourcing_accepted,
            TaskType::ScreeningCall => &mut profile.screening_accepted,
            TaskType::ReferenceCheck => &mut profile.reference_accepted,
        };
        *per_type = per_type.checked_add(1).ok_or(ScoutError::Overflow)?;
    }
    profile.total_earned = profile.total_earned.checked_add(payout).ok_or(ScoutError::Overflow)?;

    emit!(SubmissionAccepted {
        role_vault: role.key(),
        task: task.key(),
        submission: submission.key(),
        scout: submission.scout,
        task_type: task.task_type,
        payout,
        fee,
        operator: profile.operator,
        operator_fee,
        held_back,
        holdback_deadline,
        bond_refunded: bond,
        auto_settled,
        accepted_by,
        review_hash,
    });
    Ok(())
}
