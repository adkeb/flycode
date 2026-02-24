import type { PolicyRuntimePatch } from "@flycode/shared-types";
import { mergePolicyPatch, savePolicyConfig, validatePolicyPatch } from "../config/policy.js";
import type { PolicyConfig, PolicyRuntimeManager } from "../types.js";
import { AppError } from "../utils/errors.js";

export class InMemoryPolicyRuntimeManager implements PolicyRuntimeManager {
  constructor(
    private policy: PolicyConfig,
    private readonly onPolicyApplied: (next: PolicyConfig) => Promise<void>
  ) {}

  getRuntime(): PolicyConfig {
    return this.policy;
  }

  validatePatch(patch: PolicyRuntimePatch) {
    return validatePolicyPatch(this.policy, patch);
  }

  async applyPatch(patch: PolicyRuntimePatch): Promise<PolicyConfig> {
    const validation = this.validatePatch(patch);
    if (!validation.ok) {
      throw new AppError({
        statusCode: 422,
        code: "INVALID_INPUT",
        message: validation.errors.map((item) => `${item.field}: ${item.message}`).join("; ")
      });
    }

    const next = mergePolicyPatch(this.policy, patch);
    const persisted = await savePolicyConfig(next);
    await this.onPolicyApplied(persisted);
    this.policy = persisted;
    return this.policy;
  }
}
