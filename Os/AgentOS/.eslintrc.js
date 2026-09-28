// Vendors and sibling platforms that AgentOS must never import. The audit
// confirmed AgentOS is provider-neutral today; this rule keeps it that way.
const FORBIDDEN_EXTERNAL = [
  { group: ['openai', 'openai/*'], message: 'AgentOS is provider-neutral. Model vendors belong behind a ModelProvider (Phase G).' },
  { group: ['@anthropic-ai/*'], message: 'AgentOS is provider-neutral. Model vendors belong behind a ModelProvider (Phase G).' },
  { group: ['@google/generative-ai', '@google-cloud/*'], message: 'AgentOS is provider-neutral. Model vendors belong behind a ModelProvider (Phase G).' },
  { group: ['langchain', 'langchain/*', '@langchain/*'], message: 'AgentOS is provider-neutral. Agent frameworks belong outside the orchestration kernel.' },
  { group: ['**/ToolOS/**', '**/ResearchOS/**', '**/MemoryOS/**', '**/ModelOS/**', '**/EvalOS/**', '**/Cosmos/**', '**/Aira/**', '**/Echo/**'], message: 'AgentOS must not import sibling platforms. Integrate through contracts only.' }
];

module.exports = {
  parser: '@typescript-eslint/parser',
  extends: [
    'plugin:@typescript-eslint/recommended',
    'prettier'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // A4: keep raw console logging out of the codebase. The structured logger
    // in src/logger.ts is the only sanctioned sink.
    'no-console': 'error',
    'no-restricted-imports': ['error', { patterns: FORBIDDEN_EXTERNAL }]
  },
  overrides: [
    {
      // Architectural boundary (minimal, enforceable today): the domain layer is
      // pure. It must not reach into transport, persistence, orchestration or
      // the client.
      //
      // Deferred: engine -> db/repositories coupling is NOT enforced here,
      // because Supervisor genuinely imports the concrete repositories today.
      // Introducing repository interfaces is Phase B work; this rule should be
      // tightened then.
      files: ['src/domain/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            ...FORBIDDEN_EXTERNAL,
            { group: ['**/api/**', '**/db/**', '**/engine/**', '**/sdk/**'], message: 'src/domain must stay pure: no transport, persistence, orchestration or client imports.' }
          ]
        }]
      }
    },
    {
      // src/logger.ts is the sanctioned logging sink; the pino instance is built there.
      files: ['src/logger.ts'],
      rules: { 'no-console': 'off' }
    }
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/']
};
