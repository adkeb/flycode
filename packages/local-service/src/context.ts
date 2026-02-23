import { loadPolicyConfig } from "./config/policy.js";
import { FileTokenManager, InMemoryPairCodeManager } from "./security/pairing.js";
import { FileAuditLogger } from "./services/audit.js";
import { DefaultFileService } from "./services/file-service.js";
import { DefaultPathPolicy } from "./services/path-policy.js";
import { DefaultProcessRunner } from "./services/process-runner.js";
import { DefaultRedactor } from "./services/redactor.js";
import { InMemoryWriteBatchManager } from "./services/write-batch-manager.js";
import { InMemoryWriteManager } from "./services/write-manager.js";
import type { ServiceContext } from "./types.js";

export async function createServiceContext(): Promise<ServiceContext> {
  const policy = await loadPolicyConfig();
  const pairCodeManager = new InMemoryPairCodeManager(policy.auth.pair_code_ttl_minutes);
  const tokenManager = new FileTokenManager(policy.auth.token_ttl_days);
  const pathPolicy = new DefaultPathPolicy(policy);
  const redactor = new DefaultRedactor(policy);
  const auditLogger = new FileAuditLogger();
  const fileService = new DefaultFileService(policy, pathPolicy, redactor);
  const writeManager = new InMemoryWriteManager(policy, pathPolicy, fileService);
  const writeBatchManager = new InMemoryWriteBatchManager(policy, pathPolicy, fileService);
  const processRunner = new DefaultProcessRunner(policy, pathPolicy, redactor);

  return {
    policy,
    pairCodeManager,
    tokenManager,
    pathPolicy,
    redactor,
    auditLogger,
    fileService,
    writeManager,
    writeBatchManager,
    processRunner
  };
}
