/**
 * FlyCode Note: Runtime dependency container
 * Creates and wires policy, auth, path policy, services, and managers used by route handlers.
 */
import { loadPolicyConfig } from "./config/policy.js";
import { FileTokenManager, InMemoryPairCodeManager } from "./security/pairing.js";
import { FileSiteKeyManager } from "./security/site-keys.js";
import { JsonAppConfigManager } from "./services/app-config-manager.js";
import { FileAuditLogger } from "./services/audit.js";
import { InMemoryConfirmationManager } from "./services/confirmation-center.js";
import { FileConsoleEventLogger } from "./services/console-log.js";
import { DefaultFileService } from "./services/file-service.js";
import { DefaultPathPolicy } from "./services/path-policy.js";
import { InMemoryPolicyRuntimeManager } from "./services/policy-runtime-manager.js";
import { DefaultProcessRunner } from "./services/process-runner.js";
import { DefaultRedactor } from "./services/redactor.js";
import { InMemoryWriteBatchManager } from "./services/write-batch-manager.js";
import { InMemoryWriteManager } from "./services/write-manager.js";
import type { ServiceContext } from "./types.js";

export async function createServiceContext(): Promise<ServiceContext> {
  let policy = await loadPolicyConfig();
  const pairCodeManager = new InMemoryPairCodeManager(policy.auth.pair_code_ttl_minutes);
  const tokenManager = new FileTokenManager(policy.auth.token_ttl_days);
  const siteKeyManager = new FileSiteKeyManager();
  await siteKeyManager.ensureSiteKeys();
  const appConfigManager = new JsonAppConfigManager();
  const appConfig = await appConfigManager.load();
  let pathPolicy = new DefaultPathPolicy(policy);
  let redactor = new DefaultRedactor(policy);
  const auditLogger = new FileAuditLogger();
  const consoleEventLogger = new FileConsoleEventLogger();
  await consoleEventLogger.cleanupExpired(appConfig.logRetentionDays);
  const confirmationManager = new InMemoryConfirmationManager(appConfigManager);
  let fileService = new DefaultFileService(policy, pathPolicy, redactor);
  let writeManager = new InMemoryWriteManager(policy, pathPolicy, fileService);
  let writeBatchManager = new InMemoryWriteBatchManager(policy, pathPolicy, fileService);
  let processRunner = new DefaultProcessRunner(policy, pathPolicy, redactor);

  const context: ServiceContext = {
    policy,
    pairCodeManager,
    tokenManager,
    siteKeyManager,
    confirmationManager,
    consoleEventLogger,
    appConfigManager,
    policyRuntimeManager: new InMemoryPolicyRuntimeManager(policy, async (nextPolicy) => {
      policy = nextPolicy;
      pathPolicy = new DefaultPathPolicy(policy);
      redactor = new DefaultRedactor(policy);
      fileService = new DefaultFileService(policy, pathPolicy, redactor);
      writeManager = new InMemoryWriteManager(policy, pathPolicy, fileService);
      writeBatchManager = new InMemoryWriteBatchManager(policy, pathPolicy, fileService);
      processRunner = new DefaultProcessRunner(policy, pathPolicy, redactor);

      context.policy = policy;
      context.pathPolicy = pathPolicy;
      context.redactor = redactor;
      context.fileService = fileService;
      context.writeManager = writeManager;
      context.writeBatchManager = writeBatchManager;
      context.processRunner = processRunner;
    }),
    pathPolicy,
    redactor,
    auditLogger,
    fileService,
    writeManager,
    writeBatchManager,
    processRunner
  };

  return context;
}
