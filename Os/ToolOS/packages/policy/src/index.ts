import { AuthorizationDecision, AuthorizationRequest, PolicyProvider } from "../../contracts/src";

export interface PolicyRule {
  action: "allow" | "deny";
  match: string;
}

export class DefaultPolicyProvider implements PolicyProvider {
  private appRules: Record<string, PolicyRule[]> = {
    "aira": [
      { action: "allow", match: "web.search" },
      { action: "deny", match: "terminal.*" },
      { action: "allow", match: "test.*" }
    ],
    "researchos": [
      { action: "allow", match: "*" }
    ],
    "echo": [
      { action: "allow", match: "echo.*" },
      { action: "allow", match: "native.all" }
    ]
  };

  public async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const rules = this.appRules[request.callerAppId] || [];
    
    // Evaluate exact match first
    const matchedRule = rules.find(r => r.match === request.capabilityOrTool);
    if (matchedRule) {
      return { allowed: matchedRule.action === "allow", reason: `Exact match ${matchedRule.action}` };
    }

    // Evaluate wildcards
    const wildcards = rules.filter(r => r.match.endsWith(".*") || r.match === "*");
    
    // Check explicit wildcard deny first
    const denyWildcard = wildcards.find(r => this.matchesWildcard(r.match, request.capabilityOrTool) && r.action === "deny");
    if (denyWildcard) {
      return { allowed: false, reason: `Wildcard deny ${denyWildcard.match}` };
    }

    // Check explicit wildcard allow
    const allowWildcard = wildcards.find(r => this.matchesWildcard(r.match, request.capabilityOrTool) && r.action === "allow");
    if (allowWildcard) {
      return { allowed: true, reason: `Wildcard allow ${allowWildcard.match}` };
    }

    return { allowed: false, reason: `Default deny for ${request.callerAppId}` };
  }

  private matchesWildcard(pattern: string, target: string): boolean {
    if (pattern === "*") return true;
    const prefix = pattern.slice(0, -1);
    return target.startsWith(prefix);
  }
}
