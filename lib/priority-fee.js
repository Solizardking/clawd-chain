// Local Helius-shaped priority fee estimate from getRecentPrioritizationFees.
// lookbackSlots, priorityLevel, and recommended are ignored. No transaction simulation.

function extractPrioritizationFees(result) {
  if (!Array.isArray(result)) return [];
  const out = [];
  for (const row of result) {
    const n = typeof row === 'number' ? row : row && row.prioritizationFee;
    if (typeof n === 'number' && Number.isFinite(n)) out.push(n);
  }
  return out;
}

function reducePriorityFees(fees) {
  const sorted = (Array.isArray(fees) ? fees : [])
    .filter(n => typeof n === 'number' && Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
  const zeros = { min: 0, low: 0, medium: 0, high: 0, veryHigh: 0, unsafeMax: 0 };
  if (!sorted.length) return { priorityFeeEstimate: 0, priorityFeeLevels: zeros };
  const n = sorted.length;
  const at = p => sorted[Math.floor(p * (n - 1))];
  const priorityFeeLevels = {
    min: sorted[0],
    low: at(0.25),
    medium: at(0.50),
    high: at(0.75),
    veryHigh: at(0.95),
    unsafeMax: sorted[n - 1],
  };
  return { priorityFeeEstimate: priorityFeeLevels.medium, priorityFeeLevels };
}

function priorityFeeResult(fees, includeAllPriorityFeeLevels) {
  const reduced = reducePriorityFees(fees);
  const result = { priorityFeeEstimate: reduced.priorityFeeEstimate };
  if (includeAllPriorityFeeLevels) result.priorityFeeLevels = reduced.priorityFeeLevels;
  return result;
}

module.exports = { extractPrioritizationFees, reducePriorityFees, priorityFeeResult };
