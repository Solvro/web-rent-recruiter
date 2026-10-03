use anchor_lang::prelude::*;

use crate::{events::AgentUpdated, state::RoleVault};

#[derive(Accounts)]
pub struct SetAgent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub company: Signer<'info>,
    #[account(mut, has_one = company)]
    pub role_vault: Box<Account<'info, RoleVault>>,
}

/// Company-only: rotate or revoke (`None`) the agent and change its limits. Tasks already created
/// stay open (the company can close them); `agent_committed` carries over to the new agent.
pub fn handle_set_agent(
    ctx: Context<SetAgent>,
    agent: Option<Pubkey>,
    agent_max_bounty: u64,
    agent_max_commitment: u64,
) -> Result<()> {
    let role = &mut ctx.accounts.role_vault;
    role.agent = agent;
    role.agent_max_bounty = agent_max_bounty;
    role.agent_max_commitment = agent_max_commitment;
    emit!(AgentUpdated { role_vault: role.key(), agent, agent_max_bounty, agent_max_commitment });
    Ok(())
}
