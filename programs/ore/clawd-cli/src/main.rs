//! clawd-ore: tiny CLI for the ORE-on-clawd PoW program.
//! Env: RPC (default https://rpc.clawdchain.trade), KEYPAIR (path to signer keypair).
use ore_api::{consts::*, sdk, state::{Bus, Config, Proof}};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{commitment_config::CommitmentConfig, compute_budget::ComputeBudgetInstruction,
    instruction::Instruction, signature::{read_keypair_file, Keypair, Signer}, transaction::Transaction};
use steel::AccountDeserialize;
use std::time::{SystemTime, UNIX_EPOCH};

fn send(rpc: &RpcClient, kp: &Keypair, ixs: &[Instruction]) -> String {
    let bh = rpc.get_latest_blockhash().expect("blockhash");
    let tx = Transaction::new_signed_with_payer(ixs, Some(&kp.pubkey()), &[kp], bh);
    match rpc.send_and_confirm_transaction(&tx) {
        Ok(s) => { println!("tx https://explorer.clawdchain.trade/tx/{s}"); s.to_string() }
        Err(e) => { eprintln!("tx failed: {e}"); std::process::exit(1) }
    }
}
fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64 }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let rpc = RpcClient::new_with_commitment(std::env::var("RPC").unwrap_or("https://rpc.clawdchain.trade".into()), CommitmentConfig::confirmed());
    let kp = read_keypair_file(std::env::var("KEYPAIR").expect("set KEYPAIR")).expect("keypair");
    let me = kp.pubkey();
    let proof_addr = sdk_proof(me);
    match args.get(1).map(|s| s.as_str()) {
        Some("init") => { send(&rpc, &kp, &[ComputeBudgetInstruction::set_compute_unit_limit(400_000), sdk::initialize(me)]); }
        Some("open") => { send(&rpc, &kp, &[sdk::open(me, me, me)]); }
        Some("status") => {
            println!("program {}\nmint {}\nconfig {}\ntreasury {}\nproof {}", ore_api::ID, MINT_ADDRESS, CONFIG_ADDRESS, TREASURY_ADDRESS, proof_addr);
            if let Ok(d) = rpc.get_account_data(&CONFIG_ADDRESS) { let c = Config::try_from_bytes(&d).unwrap(); println!("min_difficulty {} base_reward_rate {} last_reset_at {}", c.min_difficulty, c.base_reward_rate, c.last_reset_at); }
            if let Ok(d) = rpc.get_account_data(&proof_addr) { let p = Proof::try_from_bytes(&d).unwrap(); println!("proof balance {} (grains, 1 ORE = 1e11) hashes {} rewards {}", p.balance, p.total_hashes, p.total_rewards); }
        }
        Some("mine") => {
            let rounds: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
            for r in 0..rounds {
                let proof = Proof::try_from_bytes(&rpc.get_account_data(&proof_addr).expect("proof; run open")).unwrap().clone();
                let config = Config::try_from_bytes(&rpc.get_account_data(&CONFIG_ADDRESS).unwrap()).unwrap().clone();
                // Wait until the hash is due (last_hash_at + 60s - tolerance).
                let wait = proof.last_hash_at + ONE_MINUTE - TOLERANCE - now();
                if wait > 0 { println!("round {r}: waiting {wait}s"); std::thread::sleep(std::time::Duration::from_secs(wait as u64)); }
                // Solve: find best drillx hash for a few seconds.
                let mut mem = drillx::equix::SolverMemory::new();
                let (mut best_n, mut best_d, mut best_diff) = (0u64, [0u8; 16], 0u32);
                let start = std::time::Instant::now(); let mut nonce = 0u64;
                while start.elapsed().as_secs() < 8 || best_diff < config.min_difficulty as u32 {
                    { let hx = drillx::hashes_with_memory(&mut mem, &proof.challenge, &nonce.to_le_bytes());
                        for h in hx { let d = h.difficulty(); if d > best_diff { best_diff = d; best_n = nonce; best_d = h.d; } }
                    }
                    nonce += 1;
                }
                println!("round {r}: best difficulty {best_diff} after {nonce} nonces");
                let bus = BUS_ADDRESSES[r % BUS_COUNT];
                let mut ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(500_000), sdk::auth(proof_addr)];
                if config.last_reset_at + EPOCH_DURATION <= now() + 5 { ixs.push(sdk::reset(me)); }
                ixs.push(sdk::mine(me, me, bus, drillx::Solution::new(best_d, best_n.to_le_bytes()), None));
                send(&rpc, &kp, &ixs);
                let _ = Bus::try_from_bytes; 
            }
        }
        Some("claim") => {
            let p = Proof::try_from_bytes(&rpc.get_account_data(&proof_addr).unwrap()).unwrap().clone();
            let ata = spl_associated_token_account::get_associated_token_address(&me, &MINT_ADDRESS);
            let mut ixs = vec![];
            if rpc.get_account(&ata).is_err() { ixs.push(spl_associated_token_account::instruction::create_associated_token_account(&me, &me, &MINT_ADDRESS, &spl_token_id())); }
            ixs.push(sdk::claim(me, ata, p.balance));
            send(&rpc, &kp, &ixs);
        }
        _ => eprintln!("usage: clawd-ore <init|open|status|mine [rounds]|claim>"),
    }
}
fn sdk_proof(a: solana_sdk::pubkey::Pubkey) -> solana_sdk::pubkey::Pubkey { ore_api::state::proof_pda(a).0 }
fn spl_token_id() -> solana_sdk::pubkey::Pubkey { solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
