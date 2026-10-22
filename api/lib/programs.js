// Program ids the clawd NFT, token, agent, and payment flows use.
// Dependency-free so the API image can copy this file alone.

const PROGRAMS = {
  core: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  candyMachine: 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
  candyGuard: 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
  agentIdentity: '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p',
  agentTools: 'TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S',
  genesis: 'GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  tokenMetadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  wrappedSol: 'So11111111111111111111111111111111111111112',
  shield: '2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH',
};

const PROGRAM_NAMES = Object.fromEntries(Object.entries(PROGRAMS).map(([name, id]) => [id, name]));

module.exports = { PROGRAMS, PROGRAM_NAMES };
