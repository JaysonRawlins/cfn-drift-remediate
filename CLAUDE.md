# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLI tool and library that remediates AWS CloudFormation stack drift. It detects drifted resources, safely removes them from the stack (with DeletionPolicy:Retain), then re-imports them with their actual current state.

## Commands

```bash
npx projen build    # Full pipeline: projen synth → compile → test → package
npx projen compile  # TypeScript compile only (tsc --build)
npx projen test     # Run Jest unit tests + ESLint
npx projen watch    # Watch mode (tsc --build -w)
npx projen eslint   # ESLint with auto-fix
```

Run a single test file:
```bash
npx jest --passWithNoTests test/template-transformer.test.ts
```

Integration tests are excluded from the default test run. They live in `test/integration/`.

## Projen

This project uses **projen** — `.projenrc.ts` is the source of truth for all project config. **Never edit generated files directly** (package.json, tsconfig.json, workflows, etc.). Instead modify `.projenrc.ts` and run `npx projen` to regenerate.

## Architecture

**Entry point** — `src/index.ts` is both the CLI entrypoint (Commander.js) and the library export for programmatic use.

**Orchestration** — `src/cli.ts` contains `remediate()`, the main 10-step process:
1. Fetch stack info and template
2. Detect and collect drifted resources
3. Filter to importable resource types
4. Build ResourceToImport descriptors with physical identifiers
5. Set DeletionPolicy:Retain on all resources (safety net)
6. Resolve cross-references via temporary stack Outputs
7. Remove drifted resources from template, update stack
8. Re-import resources via IMPORT change set
9. Restore original template

**Key modules in `src/lib/`:**
- `cfn-client.ts` — AWS SDK wrapper (CloudFormation API calls with polling)
- `template-transformer.ts` — Pure functions for CloudFormation template manipulation (parse, stringify, add/remove resources, resolve Ref/GetAtt)
- `eligible-resources.ts` — Static registry of ~100 importable resource types with their identifier fields
- `resource-importer.ts` — Maps drifted resources to ResourceToImport descriptors, including special-case identifier handling for S3, SQS, Lambda, etc.
- `types.ts` — TypeScript interfaces
- `utils.ts` — sleep, deepClone, Logger

**Template parsing** uses `yaml-cfn` which correctly handles CloudFormation intrinsic functions (`!Ref`, `!GetAtt`, etc.).

## PR Title Convention

Semantic PR titles required. Allowed prefixes: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `revert`, `ci`, `build`, `deps`, `wip`, `release`.

## Runtime Versions

Node 20.19.0 and Yarn 1.22.22 (pinned in `.tool-versions`). Release workflow uses Node 24 for OIDC-based npm publishing.
