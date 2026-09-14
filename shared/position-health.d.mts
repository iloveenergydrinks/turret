export type HealthStatus = 'no-debt' | 'unknown' | 'eligible' | 'critical' | 'warning' | 'healthy';
export type Health = { status: HealthStatus; ltvBps: bigint | null; bufferBps: bigint | null; liquidationPrice: bigint | null };
export function positionHealth(input: { collateral: bigint; debt: bigint; price: bigint | null; liquidationLtvBps: bigint }): Health;
