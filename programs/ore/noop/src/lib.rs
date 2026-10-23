//! CU-minimal noop program used by ORE-on-clawd for proof authentication (instruction introspection).
use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};
entrypoint!(noop);
fn noop(_: &Pubkey, _: &[AccountInfo], _: &[u8]) -> ProgramResult { Ok(()) }
