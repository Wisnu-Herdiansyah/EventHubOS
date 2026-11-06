import { loadApiConfig } from '@eventhub/config';
import { createPool } from '@eventhub/db';
import { buildApp, loggerOptions } from './app.ts';
import { DatabaseSessionAuthenticator } from './modules/identity/authenticator.ts';

const config = loadApiConfig(process.env);
const pool = createPool({
  connectionString: config.database.appUrl,
  applicationName: 'eventhub-api',
});
const app = await buildApp({
  pool,
  authenticator: new DatabaseSessionAuthenticator(pool),
  logger: loggerOptions(config.logLevel),
  trustProxy: config.http.trustProxy,
  rateLimitPerMinute: config.rateLimitPerMinute,
  validateResponses: config.environment !== 'production',
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.http.host, port: config.http.port });
