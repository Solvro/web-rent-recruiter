use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const ROLE_SEED: &[u8] = b"role";
#[constant]
pub const SCOUT_SEED: &[u8] = b"scout";
#[constant]
pub const SUBMISSION_SEED: &[u8] = b"submission";

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_REJECT_REASON: u8 = 3;
/// Stored in `Submission::reject_reason` while not rejected.
pub const NO_REJECT_REASON: u8 = u8::MAX;
