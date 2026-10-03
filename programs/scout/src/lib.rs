pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2");

/// Scout: companies fund a program-owned vault per role; scouts submit candidates;
/// accepted (or unanswered after the review window) submissions are paid out by the
/// program itself. The platform never holds the budget.
#[program]
pub mod scout {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16, treasury: Pubkey) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx, fee_bps, treasury)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_role(
        ctx: Context<CreateRole>,
        role_id: u64,
        bounty_per_candidate: u64,
        max_candidates: u16,
        review_window_seconds: i64,
        initial_deposit: u64,
        agent: Option<Pubkey>,
    ) -> Result<()> {
        instructions::create_role::handle_create_role(
            ctx,
            role_id,
            bounty_per_candidate,
            max_candidates,
            review_window_seconds,
            initial_deposit,
            agent,
        )
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        instructions::top_up::handle_top_up(ctx, amount)
    }

    pub fn register_scout(ctx: Context<RegisterScout>) -> Result<()> {
        instructions::register_scout::handle_register_scout(ctx)
    }

    pub fn submit_candidate(ctx: Context<SubmitCandidate>, candidate_hash: [u8; 32]) -> Result<()> {
        instructions::submit_candidate::handle_submit_candidate(ctx, candidate_hash)
    }

    pub fn accept_submission(ctx: Context<AcceptSubmission>) -> Result<()> {
        instructions::accept_submission::handle_accept_submission(ctx)
    }

    pub fn reject_submission(ctx: Context<RejectSubmission>, reason_code: u8) -> Result<()> {
        instructions::reject_submission::handle_reject_submission(ctx, reason_code)
    }

    pub fn settle_expired(ctx: Context<SettleExpired>) -> Result<()> {
        instructions::settle_expired::handle_settle_expired(ctx)
    }

    pub fn close_role(ctx: Context<CloseRole>) -> Result<()> {
        instructions::close_role::handle_close_role(ctx)
    }
}
