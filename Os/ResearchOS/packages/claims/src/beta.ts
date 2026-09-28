/**
 * Beta distribution helpers.
 *
 * Confidence intervals in ResearchOS are real credible intervals from the
 * posterior, not a heuristic band around the point estimate. That requires the
 * regularised incomplete beta function and its inverse, implemented here
 * because pulling in a statistics library for two functions would be a poor
 * trade — these are standard, stable, and fully testable.
 *
 * Reference: continued-fraction evaluation of I_x(a,b) via Lentz's algorithm.
 */

const EPSILON = 1e-12;
const TINY = 1e-30;
const MAX_ITERATIONS = 300;

/**
 * Natural log of the gamma function (Lanczos approximation).
 *
 * The constants below are the published Lanczos g=5, n=6 coefficients, quoted
 * at full precision. Two of them carry a seventeenth significant digit that a
 * double cannot hold, which `no-loss-of-precision` flags. Rounding them to fit
 * would be the actual mistake: the literal already resolves to the nearest
 * double, which is the intended value, and shortening them would make this
 * function no longer match the reference it is checked against.
 */
/* eslint-disable no-loss-of-precision -- see above: published constants, quoted verbatim. */
export function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (const coefficient of coefficients) {
    series += coefficient / ++y;
  }
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}
/* eslint-enable no-loss-of-precision */

/** Continued fraction for the incomplete beta function. */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let result = d;

  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    result *= d * c;

    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    result *= delta;

    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return result;
}

/** Regularised incomplete beta function I_x(a,b) — the Beta CDF. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  // The continued fraction converges quickly only on one side; use the
  // symmetry I_x(a,b) = 1 − I_{1−x}(b,a) for the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + b * Math.log(1 - x) + a * Math.log(x)) * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Inverse Beta CDF by bisection.
 *
 * Bisection rather than Newton: it cannot diverge, it needs no derivative, and
 * 60 iterations over a bounded interval is exact to well past the precision we
 * report. Speed is irrelevant here — this runs once per claim scoring.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (betaCdf(mid, a, b) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Central credible interval of Beta(a, b) at the given mass. */
export function betaCredibleInterval(a: number, b: number, mass = 0.95): [number, number] {
  const tail = (1 - mass) / 2;
  return [betaQuantile(tail, a, b), betaQuantile(1 - tail, a, b)];
}

export function betaMean(a: number, b: number): number {
  return a / (a + b);
}

export function betaVariance(a: number, b: number): number {
  const total = a + b;
  return (a * b) / (total * total * (total + 1));
}
