//! Accounting invariants, asserted on-chain after every instruction that changes a role's budget.
//! They are implied by the arithmetic in the handlers; checking them explicitly turns any future
//! accounting bug into a failed transaction instead of a silently under-funded vault.
//!
//! For a RoleVault `r` with vault token balance `V`:
//!   I1  V ≥ r.pending_value + r.held_back_total + r.bonds_held
//!       Every pending deliverable is fully funded, every held-back payout and every posted bond is
//!       still in the vault.
//!   I2  r.open_capacity ≤ V − r.held_back_total − r.bonds_held
//!       Open tasks never promise more than the free budget. (Implies I1 through I3.)
//!   I3  r.pending_value ≤ r.open_capacity
//!       Pending deliverables are a subset of the open tasks' remaining slots.
//! For a Task `t`:
//!   I4  t.accepted_count + t.pending_count ≤ t.max_deliverables
//!
//! Why they hold: an accept removes exactly `bounty` from the free budget (`payout + fee +
//! operator_fee` leave the vault, `held_back` moves into `held_back_total`; see `math::split`) and
//! exactly `bounty` from `open_capacity`. A Fabricated refund or a holdback release lowers `V` and
//! `held_back_total` by the same amount. A bond raises `V` and `bonds_held` together; accept/settle
//! returns it (both drop), reject forfeits it (`bonds_held` drops, so the free budget grows).
//! `top_up` and direct transfers into the vault only raise `V`.

use anchor_lang::prelude::*;

use crate::{
    error::ScoutError,
    state::{RoleVault, Task},
};

pub fn check_role(role: &RoleVault, vault_balance: u64) -> Result<()> {
    let reserved = role.held_back_total.checked_add(role.bonds_held);
    let free = reserved.and_then(|r| vault_balance.checked_sub(r));
    let funded = reserved
        .and_then(|r| r.checked_add(role.pending_value))
        .is_some_and(|owed| vault_balance >= owed); // I1
    require!(
        funded && free.is_some_and(|free| role.open_capacity <= free) // I2
            && role.pending_value <= role.open_capacity, // I3
        ScoutError::InvariantViolated
    );
    Ok(())
}

pub fn check_task(task: &Task) -> Result<()> {
    require!(
        u32::from(task.accepted_count) + u32::from(task.pending_count) <= u32::from(task.max_deliverables), // I4
        ScoutError::InvariantViolated
    );
    Ok(())
}
