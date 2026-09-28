import { buildServer } from './api/server';
import { config } from './config';
import { logger } from './logger';

async function main() {
  const server = await buildServer();
  try {
    await server.listen({ port: config.PORT, host: config.HOST });
    logger.info('EvalOS server listening on ' + config.HOST + ':' + config.PORT);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
