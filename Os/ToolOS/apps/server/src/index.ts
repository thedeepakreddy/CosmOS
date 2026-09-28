import { buildApp } from './app';
import { EchoAdapter } from '../../../packages/adapters/src/echo';

buildApp({
  adapters: [new EchoAdapter()] // Production loads real adapters only
}).then(app => {
  app.listen({ port: 3000, host: '127.0.0.1' }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`ToolOS server listening on ${address}`);
  });
});
