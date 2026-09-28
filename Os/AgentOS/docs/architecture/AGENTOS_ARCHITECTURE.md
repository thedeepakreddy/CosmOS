# AgentOS Architecture

## Overview
AgentOS is the reusable agent orchestration, lifecycle, coordination, supervision, and execution-control platform for the AI ecosystem.

## Components
- **API (Fastify)**: Exposes endpoints to create agents, create runs, start/pause/resume runs, and fetch task data. Uses Zod for schema validation.
- **Engine (Supervisor)**: The core state machine. Evaluates run states, ensures dependencies (DAG validation), schedules ready tasks respecting concurrency limits, and handles failures/timeouts.
- **Persistence (SQLite)**: Real durable storage (`better-sqlite3`) to enable pausing, restarting processes, and resuming tasks correctly. Stores runs, tasks, agents, and events.
- **SDK**: A TypeScript wrapper around the API for easy integrations.

## State Machines
- **Run State**: CREATED -> RUNNING <-> PAUSED -> COMPLETED | FAILED | TIMED_OUT | CANCELLED
- **Task State**: PENDING | BLOCKED -> READY -> RUNNING -> SUCCEEDED | FAILED | TIMED_OUT | SKIPPED
