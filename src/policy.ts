import type {
  PolicyAdmissionHandler,
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicyIntegrationProof,
  PolicyMode,
  PolicyOptions,
  PolicySettlementRequest,
} from "./types.js";

export interface PolicyAdmissionClient {
  readonly mode: PolicyMode;
  admit(request: PolicyAdmissionRequest): Promise<PolicyAdmissionResult>;
  settle(request: PolicySettlementRequest): Promise<unknown>;
}

export class CostKeyPolicyRefused extends Error {
  readonly code = "COSTKEY_POLICY_REFUSED";
  readonly reason: string;
  readonly policyId?: string;
  readonly policyVersion?: number | null;
  readonly scope?: Record<string, string>;
  readonly allowance?: Record<string, unknown>;
  readonly window?: string;
  readonly retryAt?: string | null;
  readonly replay?: boolean;
  readonly policies?: Array<Record<string, unknown>>;

  constructor(input: {
    reason: string;
    message?: string;
    policyId?: string;
    policyVersion?: number | null;
    scope?: Record<string, string>;
    allowance?: Record<string, unknown>;
    window?: string;
    retryAt?: string | null;
    replay?: boolean;
    policies?: Array<Record<string, unknown>>;
  }) {
    super(input.message ?? `CostKey policy refused this call: ${input.reason}`);
    this.name = "CostKeyPolicyRefused";
    this.reason = input.reason;
    this.policyId = input.policyId;
    this.policyVersion = input.policyVersion;
    this.scope = input.scope;
    this.allowance = input.allowance;
    this.window = input.window;
    this.retryAt = input.retryAt;
    this.replay = input.replay;
    this.policies = input.policies;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      reason: this.reason,
      message: this.message,
      ...(this.policyId ? { policyId: this.policyId } : {}),
      ...(this.policyVersion !== undefined ? { policyVersion: this.policyVersion } : {}),
      ...(this.scope ? { scope: this.scope } : {}),
      ...(this.allowance ? { allowance: this.allowance } : {}),
      ...(this.window ? { window: this.window } : {}),
      ...(this.retryAt !== undefined ? { retryAt: this.retryAt } : {}),
      ...(this.replay !== undefined ? { replay: this.replay } : {}),
      ...(this.policies ? { policies: this.policies } : {}),
    };
  }
}

export class CostKeyPolicyClient implements PolicyAdmissionClient {
  readonly mode: PolicyMode;
  private readonly endpoint: string;
  private readonly settlementEndpoint: string;
  private readonly authKey: string;
  private readonly timeout: number;
  private readonly handler: PolicyAdmissionHandler | null;
  private readonly integration?: PolicyIntegrationProof;
  private readonly scope?: Record<string, string>;

  constructor(options: {
    endpoint: string;
    authKey: string;
    policy: PolicyOptions;
  }) {
    this.endpoint = options.endpoint;
    this.settlementEndpoint = this.endpoint.replace(/\/admit\/?$/, "/settle");
    this.authKey = options.authKey;
    const policy = options.policy;
    this.mode = policy.mode ?? "monitor";
    if (this.mode !== "monitor" && this.mode !== "enforce") {
      throw new TypeError("CostKey policy mode must be monitor or enforce");
    }
    this.timeout = policy.timeout ?? 2_000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) {
      throw new RangeError("CostKey policy timeout must be positive");
    }
    this.handler = policy.admission ?? null;
    this.integration = policy.integration;
    this.scope = policy.scope;
  }

  /**
   * Ask for an allow/deny decision. The request carries the provider request
   * skeleton; the server (or your admission callback) estimates usage bounds.
   * The SDK only enforces the answer.
   */
  async admit(request: PolicyAdmissionRequest): Promise<PolicyAdmissionResult> {
    const payload: PolicyAdmissionRequest = {
      ...request,
      ...(this.integration ? { integration: this.integration } : {}),
      ...(this.scope ? { scope: this.scope } : {}),
    };

    if (this.handler) {
      try {
        const result = await this.handler(payload);
        if (result === false) {
          if (this.mode === "enforce") {
            throw new CostKeyPolicyRefused({ reason: "budget_exhausted" });
          }
          return allowResult();
        }
        if (result === true) return allowResult();
        return this.normalizeResult(result, 200);
      } catch (error) {
        if (error instanceof CostKeyPolicyRefused) throw error;
        if (this.mode === "enforce") throw unavailable(error);
        return allowResult();
      }
    }

    try {
      const response = await this.request(this.endpoint, payload);
      return this.normalizeResult(response.body, response.status);
    } catch (error) {
      if (error instanceof CostKeyPolicyRefused) throw error;
      if (this.mode === "enforce") throw unavailable(error);
      return allowResult();
    }
  }

  async settle(request: PolicySettlementRequest): Promise<unknown> {
    const response = await this.request(this.settlementEndpoint, request);
    if (response.status < 200 || response.status >= 300) {
      throw unavailable();
    }
    return response.body;
  }

  private normalizeResult(body: unknown, _status: number): PolicyAdmissionResult {
    const value = asRecord(body);
    const decision = value["decision"];
    const allowed = value["allowed"];
    if (decision === "refuse" || allowed === false) {
      if (this.mode === "enforce") throw refusalFrom(value);
      return allowResult();
    }
    if (decision === "allow" || allowed === true) {
      const result = {
        ...value,
        decision: "allow" as const,
        providerCallAllowed: value["providerCallAllowed"] !== false,
      } as PolicyAdmissionResult;
      if (result.providerCallAllowed === false) {
        throw new CostKeyPolicyRefused({
          reason: "idempotency_conflict",
          message: "This admission was already used; the provider call was not repeated",
          replay: result.replay,
        });
      }
      return result;
    }
    if (this.mode === "enforce") throw unavailable();
    // A monitor policy is observation-only. A malformed or unavailable
    // monitor decision cannot block the provider call.
    return allowResult();
  }

  private async request(
    target: string,
    payload: PolicyAdmissionRequest | PolicySettlementRequest,
  ): Promise<{ status: number; body: unknown }> {
    const endpoint = target;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Preserve the status; malformed response is decision_unavailable in enforce mode.
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function allowResult(): PolicyAdmissionResult {
  return { decision: "allow", replay: false, providerCallAllowed: true };
}

function refusalFrom(value: Record<string, unknown>): CostKeyPolicyRefused {
  return new CostKeyPolicyRefused({
    reason: typeof value["reason"] === "string" ? value["reason"] : "decision_unavailable",
    message: typeof value["message"] === "string" ? value["message"] : undefined,
    policyId: typeof value["policyId"] === "string" ? value["policyId"] : undefined,
    policyVersion: typeof value["policyVersion"] === "number" ? value["policyVersion"] : null,
    scope: asRecord(value["scope"]) as Record<string, string> | undefined,
    allowance: asRecord(value["allowance"]),
    window: typeof value["window"] === "string" ? value["window"] : undefined,
    retryAt: typeof value["retryAt"] === "string" ? value["retryAt"] : null,
    replay: typeof value["replay"] === "boolean" ? value["replay"] : undefined,
    policies: Array.isArray(value["policies"]) ? value["policies"].filter(isRecord) : undefined,
  });
}

function unavailable(_cause?: unknown): CostKeyPolicyRefused {
  return new CostKeyPolicyRefused({
    reason: "decision_unavailable",
    message: "CostKey policy admission is unavailable",
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
