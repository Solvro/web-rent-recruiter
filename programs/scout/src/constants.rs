use anchor_lang::prelude::*;

#[constant]
/// v3.2 moved Config to a new address (its layout grew); the v1–v3.1 `["config"]` account is abandoned.
pub const CONFIG_SEED: &[u8] = b"config_v2";
#[constant]
pub const ROLE_SEED: &[u8] = b"role";
#[constant]
pub const TASK_SEED: &[u8] = b"task";
#[constant]
pub const SCOUT_SEED: &[u8] = b"scout";
#[constant]
pub const SUBMISSION_SEED: &[u8] = b"submission";
#[constant]
pub const OPERATOR_SEED: &[u8] = b"operator";

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_REJECT_REASON: u8 = 3;
pub const MAX_HOLDBACK_BPS: u16 = 5_000;
pub const MAX_OPERATOR_FEE_BPS: u16 = 2_000;
pub const MAX_BOND_BPS: u16 = 2_000;
/// Platform fee ceiling, enforced at initialize_config / update_config.
pub const MAX_FEE_BPS: u16 = 2_000;
/// Absolute window bounds; Config narrows them (devnet: 60 s ..= 90 days).
pub const ABS_MIN_WINDOW_SECONDS: i64 = 1;
pub const ABS_MAX_WINDOW_SECONDS: i64 = 365 * 24 * 60 * 60;
pub const MAX_OPERATOR_NAME_LEN: usize = 32;
/// Stored in `Submission::reject_reason` while not rejected.
pub const NO_REJECT_REASON: u8 = u8::MAX;
