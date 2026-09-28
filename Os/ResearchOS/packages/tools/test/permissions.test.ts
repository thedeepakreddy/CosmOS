/**
 * Permission rules.
 *
 * These are the security boundary between a model and the world, so they are
 * tested exhaustively and by their failure cases first. Every test here asks
 * "what does an agent that has been talked into something malicious get?" and
 * the answer must always be: refused, with a reason.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ToolDescriptor, ToolPermissionPolicy, type ToolCapability, type ToolRiskLevel } from "@research-os/contracts";
import type { ResearchError } from "@research-os/shared";
import {
  assertPathAllowed, assertUrlAllowed, evaluateHostPermission, evaluateToolPermission, isPrivateAddress,
} from "../src/index.ts";

function descriptor(overrides: Partial<{ id: string; capability: ToolCapability; riskLevel: ToolRiskLevel }> = {}) {
  return ToolDescriptor.parse({
    id: overrides.id ?? "web_fetch",
    name: "Test tool",
    description: "A tool for tests",
    capability: overrides.capability ?? "web_fetch",
    riskLevel: overrides.riskLevel ?? "read_only",
    inputSchema: {},
    provider: "local",
  });
}

const policy = (overrides: Record<string, unknown> = {}) =>
  ToolPermissionPolicy.parse({
    allowedToolIds: ["web_fetch"],
    allowedCapabilities: ["web_fetch"],
    maxRiskLevel: "read_only",
    ...overrides,
  });

describe("evaluateToolPermission", () => {
  test("allows a tool the policy names by id, capability and risk", () => {
    assert.equal(evaluateToolPermission(descriptor(), policy()).allowed, true);
  });

  test("an empty policy permits nothing", () => {
    const decision = evaluateToolPermission(descriptor(), ToolPermissionPolicy.parse({}));
    assert.equal(decision.allowed, false, "default-deny is the entire point");
  });

  test("a tool id not in the policy is refused even when its capability is allowed", () => {
    const decision = evaluateToolPermission(
      descriptor({ id: "some_other_fetcher" }),
      policy({ allowedCapabilities: ["web_fetch"] }),
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /does not list tool/);
  });

  test("a capability not in the policy is refused even when the tool id is allowed", () => {
    const decision = evaluateToolPermission(
      descriptor({ id: "web_fetch", capability: "terminal" }),
      policy({ allowedToolIds: ["web_fetch"], allowedCapabilities: ["web_fetch"] }),
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /terminal/);
  });

  test("risk level is a ceiling, not a suggestion", () => {
    const dangerous = descriptor({ id: "terminal", capability: "terminal", riskLevel: "privileged" });
    const permissive = policy({ allowedToolIds: ["terminal"], allowedCapabilities: ["terminal"], maxRiskLevel: "side_effecting" });
    const decision = evaluateToolPermission(dangerous, permissive);
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed === false ? decision.reason : "", /exceeds the policy maximum/);

    const raised = policy({ allowedToolIds: ["terminal"], allowedCapabilities: ["terminal"], maxRiskLevel: "privileged" });
    assert.equal(evaluateToolPermission(dangerous, raised).allowed, true);
  });

  test("filesystem access with no granted root is refused", () => {
    const reader = descriptor({ id: "read_file", capability: "filesystem_read" });
    const noRoots = policy({ allowedToolIds: ["read_file"], allowedCapabilities: ["filesystem_read"] });
    assert.equal(evaluateToolPermission(reader, noRoots).allowed, false);

    const withRoot = policy({ allowedToolIds: ["read_file"], allowedCapabilities: ["filesystem_read"], allowedPathRoots: ["/srv/corpus"] });
    assert.equal(evaluateToolPermission(reader, withRoot).allowed, true);
  });
});

describe("evaluateHostPermission", () => {
  test("an empty allowlist permits anything not blocked", () => {
    assert.equal(evaluateHostPermission("example.org", policy()).allowed, true);
  });

  test("a non-empty allowlist permits only those hosts and their subdomains", () => {
    const restricted = policy({ allowedDomains: ["arxiv.org"] });
    assert.equal(evaluateHostPermission("arxiv.org", restricted).allowed, true);
    assert.equal(evaluateHostPermission("export.arxiv.org", restricted).allowed, true);
    assert.equal(evaluateHostPermission("evil.com", restricted).allowed, false);
    assert.equal(evaluateHostPermission("arxiv.org.evil.com", restricted).allowed, false, "a suffix must be on a label boundary");
  });

  test("the blocklist wins over the allowlist", () => {
    const both = policy({ allowedDomains: ["example.org"], blockedDomains: ["secret.example.org"] });
    assert.equal(evaluateHostPermission("public.example.org", both).allowed, true);
    assert.equal(evaluateHostPermission("secret.example.org", both).allowed, false);
  });

  test("host matching is case-insensitive and tolerates a trailing dot", () => {
    const restricted = policy({ allowedDomains: ["Example.ORG"] });
    assert.equal(evaluateHostPermission("example.org.", restricted).allowed, true);
  });
});

describe("isPrivateAddress", () => {
  test("blocks loopback, private ranges and cloud metadata", () => {
    for (const host of [
      "localhost", "app.localhost", "printer.local", "db.internal",
      "127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
      "::1", "fe80::1", "fd00::1",
    ]) {
      assert.equal(isPrivateAddress(host), true, `${host} must be treated as private`);
    }
  });

  test("allows ordinary public hosts", () => {
    for (const host of ["example.org", "arxiv.org", "8.8.8.8", "172.32.0.1", "192.169.0.1", "1.1.1.1"]) {
      assert.equal(isPrivateAddress(host), false, `${host} must be reachable`);
    }
  });

  test("a malformed address is refused rather than allowed by default", () => {
    assert.equal(isPrivateAddress("999.1.1.1"), true, "when in doubt, refuse");
  });
});

describe("assertUrlAllowed", () => {
  test("accepts a permitted public https URL and returns it parsed", () => {
    const url = assertUrlAllowed("https://arxiv.org/abs/1234", policy({ allowedDomains: ["arxiv.org"] }), "web_fetch");
    assert.equal(url.hostname, "arxiv.org");
  });

  test("refuses non-http schemes", () => {
    for (const bad of ["file:///etc/passwd", "ftp://example.org/x", "data:text/html,hi"]) {
      assert.throws(
        () => assertUrlAllowed(bad, policy(), "web_fetch"),
        (error: ResearchError) => error.code === "tool_not_permitted",
        `${bad} must be refused`,
      );
    }
  });

  test("refuses the cloud metadata endpoint even under a wide-open policy", () => {
    assert.throws(
      () => assertUrlAllowed("http://169.254.169.254/latest/meta-data/", policy(), "web_fetch"),
      (error: ResearchError) => error.code === "tool_not_permitted" && /link-local or private/.test(error.message),
    );
  });

  test("refuses a malformed URL with a validation error, not a crash", () => {
    assert.throws(
      () => assertUrlAllowed("not a url", policy(), "web_fetch"),
      (error: ResearchError) => error.code === "validation_failed",
    );
  });
});

describe("assertPathAllowed", () => {
  const fsPolicy = policy({ allowedPathRoots: ["/srv/corpus", "/data/sets"] });

  test("permits a path under a granted root", () => {
    assert.doesNotThrow(() => assertPathAllowed("/srv/corpus/paper.pdf", fsPolicy, "read_file"));
    assert.doesNotThrow(() => assertPathAllowed("/srv/corpus", fsPolicy, "read_file"));
  });

  test("refuses a path outside every root", () => {
    assert.throws(
      () => assertPathAllowed("/etc/passwd", fsPolicy, "read_file"),
      (error: ResearchError) => error.code === "tool_not_permitted",
    );
  });

  test("refuses traversal outright rather than resolving it", () => {
    assert.throws(
      () => assertPathAllowed("/srv/corpus/../../etc/passwd", fsPolicy, "read_file"),
      (error: ResearchError) => /parent-directory segment/.test(error.message),
    );
  });

  test("a sibling directory sharing a prefix is not inside the root", () => {
    assert.throws(
      () => assertPathAllowed("/srv/corpus-private/secret", fsPolicy, "read_file"),
      (error: ResearchError) => error.code === "tool_not_permitted",
      "prefix matching must respect the path separator",
    );
  });
});
