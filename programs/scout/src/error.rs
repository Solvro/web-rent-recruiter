use anchor_lang::prelude::*;

#[error_code]
pub enum ScoutError {
    #[msg("Fee must be between 0 and 10000 basis points")]
    InvalidFee,
    #[msg("Review window, claim timeout and holdback window must be positive")]
    InvalidRoleParams,
    #[msg("Bounty and max deliverables must be positive")]
    InvalidTaskParams,
    #[msg("Task id must equal role.task_count")]
    InvalidTaskId,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Role is closed")]
    RoleClosed,
    #[msg("Task is closed")]
    TaskClosed,
    #[msg("Task has no free deliverable slots")]
    TaskFull,
    #[msg("Open tasks would promise more than the vault holds; top up or close a task")]
    OverCommitted,
    #[msg("Vault cannot fund another pending deliverable; top up the budget")]
    InsufficientBudget,
    #[msg("Submission is not pending")]
    NotPending,
    #[msg("Signer is neither the company nor its delegated agent")]
    Unauthorized,
    #[msg("Review window has not expired yet")]
    ReviewWindowOpen,
    #[msg("Review window has expired; the submission can only be settled")]
    ReviewWindowExpired,
    #[msg("Unknown reject reason code")]
    InvalidReason,
    #[msg("There are pending deliverables")]
    PendingSubmissions,
    #[msg("Role still has open tasks")]
    OpenTasks,
    #[msg("Token account does not belong to the expected owner or mint")]
    InvalidTokenAccount,
    #[msg("Screening and reference gigs need an evidence hash of the notes")]
    MissingEvidence,
    #[msg("Only exclusive gigs can be claimed")]
    NotExclusive,
    #[msg("Gig is already claimed")]
    AlreadyClaimed,
    #[msg("Only the claimant can do this")]
    NotClaimant,
    #[msg("Gig is not claimed")]
    NotClaimed,
    #[msg("Claim timeout has not passed yet")]
    ClaimTimeoutOpen,
    #[msg("Holdback must be 0..=5000 bps")]
    InvalidHoldback,
    #[msg("Submission is not accepted")]
    NotAccepted,
    #[msg("Outcome was already attested")]
    OutcomeAlreadySet,
    #[msg("Outcome must be Advanced or Fabricated")]
    InvalidOutcome,
    #[msg("Holdback window has expired; fabrication can no longer be claimed")]
    HoldbackWindowExpired,
    #[msg("Holdback window is still open")]
    HoldbackWindowOpen,
    #[msg("Nothing is held back for this submission")]
    NothingHeldBack,
    #[msg("Role still has held-back payouts")]
    HoldbackOutstanding,
    #[msg("Operator fee must be at most 2000 bps")]
    InvalidOperatorFee,
    #[msg("Operator name must be 1..=32 bytes")]
    InvalidOperatorName,
    #[msg("Vouching needs both the operator account and its authority's signature")]
    OperatorSignatureRequired,
    #[msg("Operator accounts don't match the scout's operator")]
    OperatorMismatch,
    #[msg("The company and its agent can't deliver to their own role")]
    SelfDealing,
    #[msg("Only the program's upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("Not enough accepted sourcing deliverables to claim this gig")]
    ReputationTooLow,
    #[msg("The scout who sourced this candidate can't screen or reference-check them")]
    SelfReview,
    #[msg("Bond must be 0..=2000 bps")]
    InvalidBond,
    #[msg("Bounty below the configured minimum")]
    BountyTooSmall,
    #[msg("Window outside the configured bounds")]
    WindowOutOfRange,
    #[msg("Config parameters out of range")]
    InvalidConfig,
    #[msg("Task exceeds the company's limits for the agent")]
    AgentCapExceeded,
    #[msg("The role's gatekeeper (agent, or company if none) must co-sign")]
    NotGatekeeper,
    #[msg("Sourcing deliverables settle only with the confirmation attestor's or the company's signature")]
    NotAttestor,
    #[msg("Accounting invariant violated")]
    InvariantViolated,
    #[msg("Arithmetic overflow")]
    Overflow,
}
