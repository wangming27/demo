export const mainAgentLimits = Object.freeze({ turns: 50, calls: 100 });
export const researchAgentLimits = Object.freeze({
  turns: 50,
  calls: 100,
  searches: 2,
  fetches: 5,
  timeoutMs: 240_000,
});
export const maxDelegations = 2;
export const maxAgentRounds = mainAgentLimits.turns + maxDelegations * researchAgentLimits.turns;
