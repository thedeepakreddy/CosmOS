import pino from 'pino';

/**
 * The single structured logger for AgentOS.
 *
 * Scope note (Phase A): this is deliberately minimal. Correlation IDs, metrics,
 * tracing and attempt history are Phase F work and are NOT implemented here.
 *
 * `redact` is defence-in-depth. Phase A's primary protection against leaking
 * secrets is that task inputs, run bodies and budgets are no longer logged at
 * all; redaction only catches fields that future code might pass in by mistake.
 */
export const loggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'input',
      '*.input',
      'output',
      '*.output',
      'payload',
      '*.payload',
      'result',
      '*.result',
      'password',
      '*.password',
      'token',
      '*.token',
      'apiKey',
      '*.apiKey',
      'secret',
      '*.secret'
    ],
    censor: '[REDACTED]'
  }
};

/** Application logger (non-request logging). */
export const logger = pino(loggerOptions);
