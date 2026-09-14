// Candidate only; never installed into a live market by importing this module.
// Both selected feeds publish on deviation or a 24h heartbeat. Independent
// updates can be almost a full heartbeat apart even when neither has failed.
export const CHAINLINK_API3_HEARTBEAT_POLICY=Object.freeze({
  primaryMaxAge:90000n,
  secondaryMaxAge:90000n,
  maxDeviationBps:200n,
  maxTimestampSkew:90000n,
});
