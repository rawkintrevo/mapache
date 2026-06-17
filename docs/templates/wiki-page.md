# Wiki Page Template

Use these templates when adding active developer wiki pages. Keep pages short, routable, and explicit about ownership.

## Subsystem Page

```markdown
# Subsystem Name

## Purpose

What this page owns and what a maintainer can answer after reading it.

## Read When

Read this before changing ...

## Canonical Owner

- Code paths:
- Runtime/deployment owners:
- Data/state owners:

## Current Behavior

Concise current behavior. Link deeper pages instead of repeating them.

## Invariants

- Stable rules future changes must preserve.

## Verification

- Local checks:
- Manual checks:
- Deploy checks:

## Last Verified Assumptions

- YYYY-MM-DD: claim and source checked.

## Related Docs

- Related page path
```

## Decision Note

```markdown
# Decision: Short Title

- Status: Proposed | Accepted | Superseded
- Date: YYYY-MM-DD
- Owners:

## Context

Why this decision is needed.

## Decision

The chosen behavior or policy.

## Consequences

Tradeoffs, risks, and follow-up work.

## Related Docs

- Subsystem page path
```

## Required Fields

- Purpose
- Read when
- Canonical owner
- Related code paths
- Related docs
- Last verified assumptions

## Related Docs

- [Wiki update protocol](../wiki-update-protocol.md)
