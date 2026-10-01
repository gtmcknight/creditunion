/// The StatementAdapter, by hand: abi.ts is generated from contracts/out, which on main doesn't have the deployed
/// adapter's functions. Spot memory for pictures (contracts/ADAPTER.md): record(union) writes where each Credit sits, orderOf(union) is where each sits now
/// (0 = open), spotsOf(union) what was last written.
export const adapterAbi = [
  { type: 'function', name: 'record', stateMutability: 'nonpayable', inputs: [{ name: 'union', type: 'address' }], outputs: [] },
  { type: 'function', name: 'orderOf', stateMutability: 'view', inputs: [{ name: 'union', type: 'address' }], outputs: [{ name: 'out', type: 'uint256[80]' }] },
  { type: 'function', name: 'spotsOf', stateMutability: 'view', inputs: [{ name: 'union', type: 'address' }], outputs: [{ name: 'out', type: 'uint256[80]' }] },
] as const;
