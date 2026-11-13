# Health-Aware Deployment and Recovery for Containerized Web Applications

M.Tech dissertation project.

## Research area

Introduction to DevOps

## Overview

This project aims to design and evaluate a health-aware deployment and recovery
workflow for containerized web applications.

The proposed workflow will deploy new application versions as candidates while
keeping the previous healthy version available. Candidates will be evaluated
using application health endpoints and runtime metrics before receiving
production traffic.

Unhealthy candidates will be rejected, while healthy candidates can be promoted.
After promotion, the system will continue monitoring application health and
initiate rollback if the active version degrades. Recovery will be verified
through the traffic-routing layer.

The proposed workflow will be experimentally evaluated against a conventional
deployment baseline under controlled failure scenarios.

## Current status

Work in progress. The following components have been implemented:

- Sample Express application (Node.js 24) with version, liveness and readiness
  endpoints
- Workload endpoint supporting deterministic HTTP error injection and
  configurable response delay
- Dockerized application with a health check, non-root execution and bounded
  graceful shutdown
- PostgreSQL 17 configured through Docker Compose with persistent storage
- PostgreSQL connection pooling with error handling and connection/query
  timeouts
- Database-aware readiness: `/ready` returns HTTP 503 when PostgreSQL is
  unavailable, while `/health` stays independent of database availability

These behaviours have been checked manually through functional tests covering database outages and recovery, readiness timeout behaviour, idle-connection error handling and graceful shutdown. There is no automated test suite yet.

Not yet implemented: experiment driver, Nginx traffic routing, conventional
baseline workflow, Prometheus/Grafana monitoring, health-aware deployment
controller, CI/CD pipeline, dashboard and the formal comparative experiments.

**No formal comparative experimental results are available yet.**

## Application endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Application information and version |
| `GET /health` | Liveness: the process is running and responding |
| `GET /ready` | Readiness: runs `SELECT 1` against PostgreSQL; 200 on success, 503 on failure |
| `GET /api/work` | Workload endpoint; the only endpoint affected by fault injection |

## Configuration

### Application settings

| Variable | Default | Purpose |
|---|---|---|
| `APP_VERSION` | `1.0.0` | Version identifier reported by the app |
| `PORT` | `3000` | HTTP listening port |
| `ERROR_EVERY_N_REQUESTS` | `0` (disabled) | Return HTTP 500 for every Nth `/api/work` request |
| `RESPONSE_DELAY_MS` | `0` (disabled) | Add a fixed delay (ms) to each `/api/work` request |

The two fault-injection variables must be non-negative integers; invalid values
make the application exit at startup.

Both fault-injection variables are passed through Docker Compose and default to
`0` (disabled). They can be configured through environment variables for local
testing.

### Database settings

Database credentials are set in `.env`:

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`

Docker Compose passes the matching connection settings to the application,
which reaches PostgreSQL through the internal Compose service name `db`.
Connections are managed through the `pg` connection pool.

## Running locally

Prerequisites: Docker Engine and Docker Compose.

From the repository root:

```
cp .env.example .env
```

Edit `.env` and replace the placeholder password with a throwaway local
password. Then validate the configuration and start the services:

```
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Verify the application:

```
curl http://localhost:3000/
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/api/work
```

The application is published on `127.0.0.1:3000` only. PostgreSQL is reachable
only on the internal Compose network.

Stop the services (the PostgreSQL volume is kept):

```
docker compose down
```

> **Security note:** `.env` contains local credentials, is ignored by Git, and
> must never be committed.

## Repository layout

```
apps/
  sample-app/     Express API, database connection pool and Dockerfile
compose.yaml      Docker Compose services for the app and PostgreSQL
.env.example      Example local database configuration
```

Further components will be added as development progresses.

## Planned evaluation

The planned evaluation will compare conventional deployment and recovery with
the proposed health-aware workflow, using controlled workloads and failure
scenarios.

Planned measurements: failure detection time, recovery time, service downtime,
failed requests, recovery success and deployment overhead. Response latency will
also be recorded as a supporting measure.

Formal experiments will be run after the core deployment and recovery
components have been implemented.