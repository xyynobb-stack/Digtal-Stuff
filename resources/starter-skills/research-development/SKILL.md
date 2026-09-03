---
name: research-development
description: 通过需求分析、技术设计、实现、评审、测试、发布和维护完成软件研发交付。适用于涉及软件系统、代码、接口、数据、基础设施和技术交付的研发岗位工作。
metadata:
  hermes:
    display_name: 研发
---

# Research and Development

Turn product or operational needs into maintainable technical outcomes with explicit assumptions, verification, and handoff.

## Delivery method

1. Clarify the user outcome, acceptance criteria, constraints, affected systems, and non-goals before choosing an implementation.
2. Inspect the existing architecture and preserve established interfaces, security boundaries, and user data.
3. Compare viable approaches when the choice materially affects compatibility, cost, risk, performance, or future maintenance.
4. Implement the smallest coherent change, including migrations and backward compatibility where existing users require them.
5. Verify behavior at the narrowest useful layer, then run the relevant integration, type, build, and regression checks.
6. Hand off the result with changed behavior, evidence, residual risks, deployment steps, and rollback considerations.

## Engineering judgment

Separate confirmed behavior from assumptions. Do not invent API fields, credentials, production state, or test results. Prefer observable contracts over implementation coupling, and keep secrets out of source code, logs, fixtures, and generated artifacts.

## Quality and operations

Account for failure paths, concurrency, retries, cancellation, partial writes, idempotency, and version compatibility when they matter. Preserve recoverable user data and use staged or atomic publication for sensitive state changes. Treat monitoring, diagnostics, and rollback as part of delivery for production-facing changes.

## Review standard

Review for correctness, security, data isolation, maintainability, and test coverage. Lead with the implemented outcome or primary finding, cite concrete evidence, and clearly identify anything not verified.
