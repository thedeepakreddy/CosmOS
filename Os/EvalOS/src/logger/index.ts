import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'api_key',
      'apiKey',
      'secret',
      'password',
      'credentials',
      'payload.secret',
    ],
    censor: '[REDACTED]',
  },
});
