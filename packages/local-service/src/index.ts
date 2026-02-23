/**
 * FlyCode Note: Service entrypoint
 * Starts the local server on localhost, prints policy path and pair code for browser extension pairing.
 */
import { buildApp } from "./app.js";
import { getPolicyFilePath } from "./config/policy.js";

const PORT = Number(process.env.FLYCODE_PORT ?? 39393);
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  const { app, context } = await buildApp();
  await app.listen({ port: PORT, host: HOST });

  const code = context.pairCodeManager.getCurrentCode();
  const expiry = context.pairCodeManager.getExpiry().toISOString();

  process.stdout.write(
    [
      "FlyCode local service started",
      `- address: http://${HOST}:${PORT}`,
      `- policy: ${getPolicyFilePath()}`,
      `- pair code (valid until ${expiry}): ${code}`,
      "- note: service only listens on 127.0.0.1"
    ].join("\n") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
