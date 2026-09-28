/**
 * Permission evaluation. Default-deny, and deliberately boring.
 *
 * Agents are untrusted actors. A model that has been fed a malicious document
 * will happily ask to read `~/.ssh/id_rsa` or POST evidence to an attacker's
 * host, and it will produce a convincing justification for doing so. So no call
 * is permitted because it seemed reasonable: a call proceeds only when the
 * policy names the tool, names its capability, and permits its risk level.
 *
 * All three are required rather than any one of them. Capability alone would
 * let a newly registered tool inherit a grant meant for a different tool;
 * tool id alone would let a tool's capability change under an existing grant.
 *
 * These functions are pure and have no I/O, so the security rules can be
 * exhaustively tested — which is the only way to trust them.
 */
import type { ToolDescriptor, ToolPermissionPolicy } from "@research-os/contracts";
import { err } from "@research-os/shared";
import { FILESYSTEM_CAPABILITIES, RISK_ORDER } from "./tool.ts";

export type PermissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const deny = (reason: string): PermissionDecision => ({ allowed: false, reason });

export function evaluateToolPermission(descriptor: ToolDescriptor, policy: ToolPermissionPolicy): PermissionDecision {
  if (!policy.allowedToolIds.includes(descriptor.id)) {
    return deny(`the policy does not list tool "${descriptor.id}"`);
  }
  if (!policy.allowedCapabilities.includes(descriptor.capability)) {
    return deny(`the policy does not allow the "${descriptor.capability}" capability`);
  }
  if (RISK_ORDER[descriptor.riskLevel] > RISK_ORDER[policy.maxRiskLevel]) {
    return deny(`tool risk level "${descriptor.riskLevel}" exceeds the policy maximum "${policy.maxRiskLevel}"`);
  }
  // Network capabilities are deliberately not gated on a non-empty allowlist:
  // per the contract an empty `allowedDomains` means "any host not blocked",
  // and per-URL checks still run at call time via `assertUrlAllowed`.
  // Filesystem access has no such default — no root granted means no access.
  if (FILESYSTEM_CAPABILITIES.has(descriptor.capability) && policy.allowedPathRoots.length === 0) {
    return deny(`"${descriptor.capability}" requires at least one allowed path root, and the policy grants none`);
  }
  return { allowed: true };
}

/**
 * Host check for a network-capable tool.
 *
 * Blocklist wins over allowlist. An empty allowlist means "anything not
 * blocked"; a non-empty one means exactly those hosts and their subdomains.
 */
export function evaluateHostPermission(hostname: string, policy: ToolPermissionPolicy): PermissionDecision {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return deny("the URL has no host");

  const matches = (pattern: string): boolean => {
    const candidate = pattern.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    return host === candidate || host.endsWith(`.${candidate}`);
  };

  if (policy.blockedDomains.some(matches)) return deny(`host "${host}" is on the policy blocklist`);
  if (policy.allowedDomains.length > 0 && !policy.allowedDomains.some(matches)) {
    return deny(`host "${host}" is not on the policy allowlist`);
  }
  return { allowed: true };
}

/**
 * Blocks requests aimed back at the machine or its private network.
 *
 * This is server-side request forgery protection, and it is separate from the
 * domain policy on purpose: an operator who allows `*` still must not hand an
 * agent a way to reach `169.254.169.254` or an internal admin service. A model
 * that has read an attacker-controlled page is exactly the actor that would try.
 *
 * Literal addresses are checked here. A hostname that *resolves* to a private
 * address is not caught by this check alone — closing that requires resolving
 * before connecting, which belongs with the socket, not with policy.
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;

  // IPv6 loopback, link-local and unique-local.
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return true; // malformed: refuse
  const [a = 0, b = 0] = octets;

  if (a === 0 || a === 10 || a === 127) return true;                 // this-network, private, loopback
  if (a === 169 && b === 254) return true;                           // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;                  // private
  if (a === 192 && b === 168) return true;                           // private
  if (a === 100 && b >= 64 && b <= 127) return true;                 // carrier-grade NAT
  if (a >= 224) return true;                                         // multicast and reserved
  return false;
}

export interface UrlCheckOptions {
  /**
   * Named private hosts that are exempt from the private-address rule.
   *
   * An exemption is per host, never a blanket switch. A deployment that fetches
   * from an internal corpus server needs `corpus.internal` reachable; it does
   * not need `169.254.169.254` reachable, and a boolean flag would have given
   * it both. Anything not named here stays blocked, so widening this costs
   * exactly one host at a time.
   *
   * Matching is exact on the hostname — no subdomains, no wildcards.
   */
  readonly allowedPrivateHosts?: readonly string[];
}

/**
 * Full check for a URL a tool is about to fetch. Throws rather than returning,
 * because there is no sensible way for a tool to continue past a denial.
 */
export function assertUrlAllowed(
  rawUrl: string,
  policy: ToolPermissionPolicy,
  toolId: string,
  options: UrlCheckOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw err.validation(`"${rawUrl}" is not a valid URL.`, { toolId, url: rawUrl });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw err.toolNotPermitted(toolId, `the "${url.protocol}" scheme is not fetchable`);
  }
  const exempt = options.allowedPrivateHosts?.some((host) => host.toLowerCase() === url.hostname.toLowerCase()) ?? false;
  if (!exempt && isPrivateAddress(url.hostname)) {
    throw err.toolNotPermitted(toolId, `"${url.hostname}" is a loopback, link-local or private address`);
  }
  const decision = evaluateHostPermission(url.hostname, policy);
  if (!decision.allowed) throw err.toolNotPermitted(toolId, decision.reason);

  return url;
}

/** Filesystem equivalent: a path must sit under one of the granted roots. */
export function assertPathAllowed(path: string, policy: ToolPermissionPolicy, toolId: string): void {
  if (policy.allowedPathRoots.length === 0) {
    throw err.toolNotPermitted(toolId, "the policy grants no filesystem roots");
  }
  // Compared as normalised absolute-ish strings. `..` is rejected outright
  // rather than resolved, so a traversal cannot be smuggled past the check by
  // a path that normalises differently here than it does at the syscall.
  if (path.includes("..")) {
    throw err.toolNotPermitted(toolId, `path "${path}" contains a parent-directory segment`);
  }
  const allowed = policy.allowedPathRoots.some((root) => {
    const normalised = root.endsWith("/") ? root : `${root}/`;
    return path === root || path.startsWith(normalised);
  });
  if (!allowed) {
    throw err.toolNotPermitted(toolId, `path "${path}" is outside every allowed root`);
  }
}
