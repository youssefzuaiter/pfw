/** Small statistics helpers shared by the recurring-detection and insight-generator engines. */

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot compute the mean of an empty array");
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number {
  // No explicit empty-array guard here: mean(values) below is always the
  // first thing that runs, and it already throws on an empty array — a
  // second guard here would be genuinely unreachable dead code, not
  // extra safety (mutation testing confirmed this: removing a
  // once-present guard here didn't change behavior for any input).
  const avg = mean(values);
  const variance = mean(values.map((v) => (v - avg) ** 2));
  return Math.sqrt(variance);
}

/** |stddev / mean|. `Infinity` when the mean is zero (avoids a 0/0 or x/0 NaN/Infinity ambiguity leaking to callers as NaN). */
export function coefficientOfVariation(values: readonly number[]): number {
  const avg = mean(values);
  if (avg === 0) return Infinity;
  return Math.abs(standardDeviation(values) / avg);
}
