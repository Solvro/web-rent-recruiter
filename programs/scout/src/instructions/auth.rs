use anchor_lang::prelude::*;

use crate::{error::ScoutError, state::RoleVault};

/// The company, or the AI agent it delegated the role to.
pub fn require_company_or_agent(role: &RoleVault, signer: &Pubkey) -> Result<()> {
    require!(
        *signer == role.company || role.agent == Some(*signer),
        ScoutError::Unauthorized
    );
    Ok(())
}
