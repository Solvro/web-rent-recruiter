use anchor_lang::prelude::*;

#[error_code]
pub enum ScoutError {
    #[msg("Fee must be between 0 and 10000 basis points")]
    InvalidFee,
    #[msg("Bounty, max candidates and review window must be positive")]
    InvalidRoleParams,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Role is closed")]
    RoleClosed,
    #[msg("Role has no free candidate slots")]
    RoleFull,
    #[msg("Vault cannot fund another pending submission; top up the budget")]
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
    #[msg("Role still has pending submissions")]
    PendingSubmissions,
    #[msg("Token account does not belong to the expected owner or mint")]
    InvalidTokenAccount,
    #[msg("Arithmetic overflow")]
    Overflow,
}
