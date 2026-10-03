pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod invariants;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2");

/// Scout: a company funds a program-owned vault per role and delegates it to an AI agent.
/// The agent posts gigs (tasks) against that budget; human scouts claim and deliver; accepted
/// (or unanswered after the review window) deliverables are paid out by the program itself.
/// The platform never holds the budget.
#[program]
pub mod scout {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, treasury: Pubkey, params: ConfigParams) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx, treasury, params)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        instructions::update_config::handle_update_config(ctx, params)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_role(
        ctx: Context<CreateRole>,
        role_id: u64,
        agent: Option<Pubkey>,
        review_window_seconds: i64,
        claim_timeout_seconds: i64,
        holdback_window_seconds: i64,
        initial_deposit: u64,
        agent_max_bounty: u64,
        agent_max_commitment: u64,
    ) -> Result<()> {
        instructions::create_role::handle_create_role(
            ctx,
            role_id,
            agent,
            review_window_seconds,
            claim_timeout_seconds,
            holdback_window_seconds,
            initial_deposit,
            agent_max_bounty,
            agent_max_commitment,
        )
    }

    pub fn set_agent(
        ctx: Context<SetAgent>,
        agent: Option<Pubkey>,
        agent_max_bounty: u64,
        agent_max_commitment: u64,
    ) -> Result<()> {
        instructions::set_agent::handle_set_agent(ctx, agent, agent_max_bounty, agent_max_commitment)
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        instructions::top_up::handle_top_up(ctx, amount)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        ctx: Context<CreateTask>,
        task_id: u32,
        task_type: TaskType,
        bounty: u64,
        max_deliverables: u16,
        exclusive: bool,
        brief_hash: [u8; 32],
        holdback_bps: u16,
        subject_scout: Option<Pubkey>,
        min_accepted: u16,
        min_accept_rate_bps: u16,
        bond_bps: u16,
        confirmation_attestor: Option<Pubkey>,
    ) -> Result<()> {
        instructions::create_task::handle_create_task(
            ctx,
            task_id,
            task_type,
            bounty,
            max_deliverables,
            exclusive,
            brief_hash,
            holdback_bps,
            subject_scout,
            min_accepted,
            min_accept_rate_bps,
            bond_bps,
            confirmation_attestor,
        )
    }

    pub fn claim_task(ctx: Context<ClaimTask>) -> Result<()> {
        instructions::claim_task::handle_claim_task(ctx)
    }

    pub fn release_claim(ctx: Context<ReleaseClaim>) -> Result<()> {
        instructions::claim_task::handle_release_claim(ctx)
    }

    pub fn close_task(ctx: Context<CloseTask>) -> Result<()> {
        instructions::close_task::handle_close_task(ctx)
    }

    pub fn register_operator(ctx: Context<RegisterOperator>, fee_bps: u16, name: String) -> Result<()> {
        instructions::register_operator::handle_register_operator(ctx, fee_bps, name)
    }

    pub fn register_scout(ctx: Context<RegisterScout>) -> Result<()> {
        instructions::register_scout::handle_register_scout(ctx)
    }

    pub fn submit_deliverable(
        ctx: Context<SubmitDeliverable>,
        deliverable_hash: [u8; 32],
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        instructions::submit_deliverable::handle_submit_deliverable(ctx, deliverable_hash, evidence_hash)
    }

    pub fn accept_submission(ctx: Context<AcceptSubmission>, review_hash: [u8; 32]) -> Result<()> {
        instructions::accept_submission::handle_accept_submission(ctx, review_hash)
    }

    pub fn reject_submission(ctx: Context<RejectSubmission>, reason_code: u8, reason_hash: [u8; 32]) -> Result<()> {
        instructions::reject_submission::handle_reject_submission(ctx, reason_code, reason_hash)
    }

    pub fn settle_expired(ctx: Context<SettleExpired>) -> Result<()> {
        instructions::settle_expired::handle_settle_expired(ctx)
    }

    pub fn attest_outcome(ctx: Context<AttestOutcome>, outcome: Outcome, reason_code: u8) -> Result<()> {
        instructions::attest_outcome::handle_attest_outcome(ctx, outcome, reason_code)
    }

    pub fn release_holdback(ctx: Context<ReleaseHoldback>) -> Result<()> {
        instructions::release_holdback::handle_release_holdback(ctx)
    }

    pub fn close_role(ctx: Context<CloseRole>) -> Result<()> {
        instructions::close_role::handle_close_role(ctx)
    }
}
