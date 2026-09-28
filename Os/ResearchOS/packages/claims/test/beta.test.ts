import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { betaCdf, betaQuantile, betaMean, betaVariance, betaCredibleInterval, logGamma } from "../src/index.ts";

describe("beta distribution helpers", () => {
  test("Beta(1,1) is the uniform distribution", () => {
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      assert.ok(Math.abs(betaCdf(x, 1, 1) - x) < 1e-9, `CDF at ${x}`);
      assert.ok(Math.abs(betaQuantile(x, 1, 1) - x) < 1e-9, `quantile at ${x}`);
    }
  });

  test("symmetric parameters give a distribution centred on 0.5", () => {
    for (const a of [2, 5, 20]) {
      assert.ok(Math.abs(betaCdf(0.5, a, a) - 0.5) < 1e-9);
      assert.equal(betaMean(a, a), 0.5);
    }
  });

  test("CDF and quantile are inverses", () => {
    for (const [a, b] of [[2, 5], [5, 2], [19, 8], [1.5, 1.5]] as const) {
      for (const p of [0.025, 0.25, 0.5, 0.75, 0.975]) {
        assert.ok(Math.abs(betaCdf(betaQuantile(p, a, b), a, b) - p) < 1e-6, `a=${a} b=${b} p=${p}`);
      }
    }
  });

  test("known 95% interval for Beta(5,5)", () => {
    const [low, high] = betaCredibleInterval(5, 5);
    assert.ok(Math.abs(low - 0.2120) < 1e-3, `lower bound ${low}`);
    assert.ok(Math.abs(high - 0.7880) < 1e-3, `upper bound ${high}`);
  });

  test("intervals narrow as evidence accumulates", () => {
    let previousWidth = Infinity;
    for (const n of [1, 2, 5, 20, 100]) {
      const [low, high] = betaCredibleInterval(1 + n, 1 + n);
      const width = high - low;
      assert.ok(width < previousWidth, `width must shrink at n=${n}`);
      previousWidth = width;
    }
  });

  test("variance is positive and shrinks with evidence", () => {
    assert.ok(betaVariance(2, 2) > betaVariance(20, 20));
    assert.ok(betaVariance(20, 20) > 0);
  });

  test("logGamma matches known factorials", () => {
    // Gamma(n) = (n-1)!
    assert.ok(Math.abs(Math.exp(logGamma(5)) - 24) < 1e-6, "Gamma(5) = 4! = 24");
    assert.ok(Math.abs(Math.exp(logGamma(6)) - 120) < 1e-5, "Gamma(6) = 5! = 120");
  });
});
