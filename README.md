# Health-Aware Deployment and Recovery for Containerized Web Applications

M.Tech dissertation project.

## Research area

Introduction to DevOps

## Overview

This project proposes a health-aware deployment workflow for containerized
web applications. After a new version is deployed as a candidate, the workflow
will check its health using health endpoints and runtime metrics. If the
candidate does not meet the defined health criteria, it will be rejected and
the previous healthy version restored, with the recovery then verified.

The workflow will be compared against a conventional baseline deployment under
controlled failure scenarios.

## Current status

Initial development environment setup. Nothing is implemented yet.
