/**
 * Numerical helpers for the Frontier math (docs/METHODOLOGY.md §3–§4).
 *
 * Pure functions, no dependencies. Everything here is deliberately small and auditable:
 * the public numbers on the site are produced by these routines, so each one names the
 * approximation it uses and the accuracy it claims.
 */

/** √(2π). */
const SQRT_2PI = 2.506628274631000502;

/**
 * Standard normal CDF Φ(x).
 *
 * Hart (1968) rational approximation in the form published by Graeme West,
 * "Better approximations to cumulative normal functions" (Wilmott, 2005).
 * Accurate to roughly double precision (|abs error| < 1e-15) over the whole real line,
 * which is far inside the 1e-8 we need.
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return 1;
  if (x === Number.NEGATIVE_INFINITY) return 0;

  const z = Math.abs(x);
  let tail: number;
  if (z > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-(z * z) / 2);
    if (z < 7.071067811865475) {
      let num = 3.52624965998911e-2 * z + 0.700383064443688;
      num = num * z + 6.37396220353165;
      num = num * z + 33.912866078383;
      num = num * z + 112.079291497871;
      num = num * z + 221.213596169931;
      num = num * z + 220.206867912376;
      let den = 8.83883476483184e-2 * z + 1.75566716318264;
      den = den * z + 16.064177579207;
      den = den * z + 86.7807322029461;
      den = den * z + 296.564248779674;
      den = den * z + 637.333633378831;
      den = den * z + 793.826512519948;
      den = den * z + 440.413735824752;
      tail = (e * num) / den;
    } else {
      // Continued fraction for the far tail.
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      tail = e / b / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

/** Standard normal PDF φ(x). */
export function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / SQRT_2PI;
}

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;

/**
 * Inverse standard normal CDF Φ⁻¹(p), p ∈ (0, 1).
 *
 * Peter Acklam's rational approximation (|relative error| < 1.15e-9) followed by one
 * Halley refinement step against {@link normalCdf}, which takes it to ~1e-15.
 * Returns ±Infinity at the open ends; callers clamp before use.
 */
export function normalInverseCdf(p: number): number {
  if (Number.isNaN(p)) return Number.NaN;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q) /
      (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
  }

  // One Halley step: cheap, and removes Acklam's 1e-9 ripple.
  const e = normalCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  if (Number.isFinite(u)) x = x - u / (1 + (x * u) / 2);
  return x;
}

/** P(T ≤ t) for T ~ LogNormal(mu, sigma), t in the same units as exp(mu). */
export function lognormalCdf(mu: number, sigma: number, t: number): number {
  if (t <= 0) return 0;
  if (!(sigma > 0)) return t >= Math.exp(mu) ? 1 : 0;
  return normalCdf((Math.log(t) - mu) / sigma);
}

/** The q-th quantile of T ~ LogNormal(mu, sigma). */
export function lognormalQuantile(mu: number, sigma: number, q: number): number {
  if (!(sigma > 0)) return Math.exp(mu);
  if (q <= 0) return 0;
  if (q >= 1) return Number.POSITIVE_INFINITY;
  return Math.exp(mu + sigma * normalInverseCdf(q));
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population (biased, ÷n) variance — the estimator METHODOLOGY §4 shrinks. */
export function populationVariance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / xs.length;
}

/** Population (÷n) standard deviation. */
export function populationSd(xs: readonly number[]): number {
  return Math.sqrt(populationVariance(xs));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
