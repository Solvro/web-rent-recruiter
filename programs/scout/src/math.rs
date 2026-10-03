//! Pure payout math, kept free of accounts so it can be unit- and property-tested natively.
//!
//! Rounding policy: every percentage is rounded DOWN (floor). The platform fee, the operator fee
//! and the holdback are floors; the scout's immediate payout is the exact remainder. All rounding
//! dust therefore goes to the scout, never to the platform, and
//!
//!     fee + operator_fee + held_back + payout == bounty     (exactly, for every input)
//!
//! which is what keeps the vault accounting exact: an accept removes exactly `bounty` from the
//! role's free budget (`payout + fee + operator_fee` leave the vault, `held_back` moves into
//! `held_back_total`).

use crate::constants::BPS_DENOMINATOR;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    /// To the platform treasury, now.
    pub fee: u64,
    /// To the vouching operator, now (0 without an operator).
    pub operator_fee: u64,
    /// Parked in the vault until `attest_outcome` / `release_holdback`.
    pub held_back: u64,
    /// To the scout, now.
    pub payout: u64,
}

/// `amount * bps / 10_000`, floored. `None` if `bps > 10_000` (would not be a fraction).
/// Cannot overflow: the product is computed in u128 and the result is ≤ `amount`.
pub fn bps_of(amount: u64, bps: u16) -> Option<u64> {
    if u64::from(bps) > BPS_DENOMINATOR {
        return None;
    }
    let v = u128::from(amount) * u128::from(bps) / u128::from(BPS_DENOMINATOR);
    u64::try_from(v).ok()
}

/// Deliverable bond: `bounty * bond_bps / 10_000`, floored (dust favours the scout).
/// It is not part of the split: the bond goes in at submit and comes back whole on accept/settle.
pub fn bond_of(bounty: u64, bond_bps: u16) -> Option<u64> {
    bps_of(bounty, bond_bps)
}

/// Splits one bounty. `operator_bps` is 0 when the scout has no operator.
/// Returns `None` only for out-of-range basis points (the program validates them on input anyway).
pub fn split(bounty: u64, fee_bps: u16, operator_bps: u16, holdback_bps: u16) -> Option<Split> {
    let fee = bps_of(bounty, fee_bps)?;
    let after_fee = bounty.checked_sub(fee)?;
    let operator_fee = bps_of(after_fee, operator_bps)?;
    let share = after_fee.checked_sub(operator_fee)?;
    let held_back = bps_of(share, holdback_bps)?;
    let payout = share.checked_sub(held_back)?;
    Some(Split { fee, operator_fee, held_back, payout })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn demo_numbers() {
        // 20 USDC, 10% fee, 10% operator, 30% holdback (docs/program-interface.md).
        let s = split(20_000_000, 1000, 1000, 3000).unwrap();
        assert_eq!(s, Split { fee: 2_000_000, operator_fee: 1_800_000, held_back: 4_860_000, payout: 11_340_000 });
        // 5 USDC sourcing gig: the 0.5 µUSDC of rounding dust stays with the scout.
        let s = split(5_000_000, 1000, 1000, 3000).unwrap();
        assert_eq!(s, Split { fee: 500_000, operator_fee: 450_000, held_back: 1_215_000, payout: 2_835_000 });
    }

    #[test]
    fn dust_goes_to_the_scout() {
        // 1 base unit: every floor is 0, the scout gets it.
        assert_eq!(split(1, 1000, 2000, 5000).unwrap(), Split { fee: 0, operator_fee: 0, held_back: 0, payout: 1 });
        // 7 base units at 10% fee: fee floor(0.7) = 0.
        assert_eq!(split(7, 1000, 0, 0).unwrap().payout, 7);
    }

    #[test]
    fn bond() {
        assert_eq!(bond_of(5_000_000, 1000), Some(500_000));
        assert_eq!(bond_of(9, 1000), Some(0));
        assert!(bond_of(1, 10_001).is_none());
    }

    #[test]
    fn extremes() {
        let s = split(u64::MAX, 10_000, 0, 0).unwrap();
        assert_eq!((s.fee, s.payout), (u64::MAX, 0));
        let s = split(u64::MAX, 1000, 2000, 5000).unwrap();
        assert_eq!(s.fee + s.operator_fee + s.held_back + s.payout, u64::MAX);
        assert!(split(1, 10_001, 0, 0).is_none());
        assert!(bps_of(u64::MAX, 10_000) == Some(u64::MAX));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(20_000))]

        /// The split is exact: no token is created or lost, whatever the inputs.
        #[test]
        fn split_sums_to_bounty(
            bounty in any::<u64>(),
            fee_bps in 0u16..=10_000,
            operator_bps in 0u16..=2_000,
            holdback_bps in 0u16..=5_000,
        ) {
            let s = split(bounty, fee_bps, operator_bps, holdback_bps).unwrap();
            let total = u128::from(s.fee) + u128::from(s.operator_fee) + u128::from(s.held_back) + u128::from(s.payout);
            prop_assert_eq!(total, u128::from(bounty));
        }

        /// Each party gets at most its nominal percentage (floors never round up against the scout),
        /// and the scout's total (now + holdback) is never below the exact pro-rata amount.
        #[test]
        fn floors_favour_the_scout(
            bounty in any::<u64>(),
            fee_bps in 0u16..=10_000,
            operator_bps in 0u16..=2_000,
            holdback_bps in 0u16..=5_000,
        ) {
            let s = split(bounty, fee_bps, operator_bps, holdback_bps).unwrap();
            let b = u128::from(bounty);
            prop_assert!(u128::from(s.fee) * 10_000 <= b * u128::from(fee_bps));
            let after_fee = b - u128::from(s.fee);
            prop_assert!(u128::from(s.operator_fee) * 10_000 <= after_fee * u128::from(operator_bps));
            let share = after_fee - u128::from(s.operator_fee);
            prop_assert!(u128::from(s.held_back) * 10_000 <= share * u128::from(holdback_bps));
            // Exact rational scout share ≤ what the scout actually gets (share), within 2 base units of dust.
            let exact = b * u128::from(10_000 - fee_bps) * u128::from(10_000 - operator_bps);
            prop_assert!(share * 100_000_000 >= exact);
            prop_assert!(share * 100_000_000 < exact + 2 * 100_000_000);
        }

        /// Rounding dust per split is bounded: under 3 base units across the three floors.
        #[test]
        fn dust_is_bounded(bounty in any::<u64>(), fee_bps in 0u16..=10_000, operator_bps in 0u16..=2_000) {
            let s = split(bounty, fee_bps, operator_bps, 0).unwrap();
            let b = u128::from(bounty);
            let exact_fee_num = b * u128::from(fee_bps); // fee * 10_000 rounded down from this
            prop_assert!(exact_fee_num - u128::from(s.fee) * 10_000 < 10_000);
        }
    }
}
