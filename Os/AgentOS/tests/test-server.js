const { buildServer } = require('../dist/api/server');

class TestAgentExecutor {
  async execute(agent, task, context) {
    const input = task.input;
    if (input && input.delayMs) {
      await new Promise(resolve => setTimeout(resolve, input.delayMs));
    }
    if (input && input.shouldFail) {
      return { status: 'FAILED', error: 'Intentional failure for testing' };
    }
    return { status: 'SUCCEEDED', output: { result: `Task ${task.name} executed by ${agent.id}` } };
  }
}

buildServer(new TestAgentExecutor()).then(app => {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const host = process.env.HOST || '0.0.0.0';
  app.listen({ port, host }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`AgentOS server listening at ${address}`);
  });
});
