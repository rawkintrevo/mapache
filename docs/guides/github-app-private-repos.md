# GitHub App / Connector Planning Guide

This guide covers the follow-on work needed to move from the current public-URL GitHub workspace flow to a GitHub App-backed connector that supports private repositories, a connected repo picker, and later PR creation.

## Current State

What exists today:

- Public GitHub HTTPS repo URLs can be used to create GitHub-backed workspaces.
- The runner can clone public repos, restore cached Git/worktree state, and expose basic Git actions.
- Push support expects runtime credentials to already exist.

What does not exist yet:

- GitHub App installation and callback flow.
- Connected repository picker.
- Short-lived installation-token minting.
- Private repo clone support.
- PR creation through the GitHub API.

## Scope of the GitHub App Phase

The GitHub App phase should add four capabilities:

1. authenticate a user against one or more GitHub App installations
2. list repositories available through those installations
3. mint short-lived installation tokens for specific operations
4. use those tokens for private repo clone, push, and PR creation

This work should not replace the existing public-URL flow. Public repo URL entry should remain as a fallback even when the App-based connector exists.

## Proposed User Flow

### 1. Connect GitHub

A signed-in app user should be able to:

- install or authorize the GitHub App
- return to Pi Agents Cloud after installation
- see whether GitHub connector support is configured for the current deployment

### 2. Pick a repository

Workspace creation should support both:

- **Connected repo** selection from the user’s available GitHub App installations
- **Public repo URL** entry as a fallback path

The connected repo response should include at minimum:

- installation id
- owner
- repo name
- default branch
- privacy flag

### 3. Create the workspace

For connected repos, the backend should store enough metadata to:

- validate the user may use that installation/repo
- mint installation tokens later without storing token values in Firestore
- distinguish public-URL mode from connected-repo mode

### 4. Run Git operations

Runtime operations that need GitHub auth should use short-lived installation tokens for:

- private repo clone
- push
- PR creation

## Token Strategy

Use short-lived GitHub App installation tokens.

Required properties:

- minted server-side only
- scoped to the installation and operation in question
- never stored in Firestore
- never written to Cloud Storage
- never logged in Functions, runner output, or frontend console output

Preferred pattern:

- Functions mint the token just-in-time
- Functions pass the token to the runner only for the immediate operation
- runner process uses the token via env or askpass-style mechanism
- token is discarded after the operation completes

## Private Repo Clone Plan

For private clone support:

- workspace source metadata should identify the connected installation/repo
- backend should mint a short-lived installation token during session provisioning or startup
- runner should use that token only for clone/fetch/push operations
- runner must not write token values into `.git/config`, file sync, or archive state

Failure messages should distinguish:

- auth not configured
- installation not found
- repository not found
- network failure
- token mint failure

## Repo Picker Plan

The repo picker API should:

- require app auth
- list only repositories the current user is allowed to access through stored installation/user linkage
- return a stable `not_configured` response when GitHub App support is not set up

The UI should:

- show an unavailable/not-configured state without fake data
- keep public URL entry available
- avoid implying private repo support exists before backend token plumbing is ready

## PR Creation Plan

PR creation should be a later step after push works through installation tokens.

Expected future flow:

1. user stages/commits/pushes changes
2. UI offers an **Open PR** action
3. backend mints a short-lived installation token
4. backend calls GitHub’s PR API
5. UI shows the resulting PR URL or actionable failure

PR defaults still need product decisions:

- direct push vs working branch model
- branch naming convention
- PR title/body defaults
- draft vs ready-for-review default

## Security Decisions Required Before Implementation

The following decisions must be made before GitHub App implementation continues:

- App owner: personal account, org, or deployment-specific org
- installation scope: all repos vs selected repos
- exact permissions for contents, metadata, pull requests, and webhooks
- callback and webhook URL strategy for `pi-agents-cloud`
- secret storage mechanism and naming
- audit/logging expectations for token-related operations

## Suggested Firestore Metadata Direction

Do not store token values.

Reasonable metadata categories:

- app user ↔ GitHub user linkage
- installation records
- repository references available through installations
- workspace source metadata for connected repos

These records should capture ownership and permission boundaries clearly enough that later APIs can verify access without guessing.

## Separation From Current Public-URL Support

Keep these two modes distinct:

### Public URL mode

- public repos only
- no GitHub App dependency
- pasted HTTPS URL

### Connected repo mode

- supports private repos
- requires GitHub App configuration
- repo picker-backed
- installation-token-backed operations

This separation reduces migration risk and keeps the current public flow usable while the App integration is incomplete.

## Recommended Implementation Order

1. planning doc and security decisions
2. GitHub App creation + secret configuration
3. Firestore metadata schema
4. placeholder repo picker API + UI unavailable state
5. installation-token minting
6. connected repo picker backend + UI
7. private repo clone support
8. push via installation tokens
9. PR creation

## ADRs to Write Before or During This Work

Use the ADR template in `adrs/template.md` for decisions such as:

- GitHub App ownership model
- repo access policy (all vs selected)
- token handoff mechanism to the runner
- branch/PR policy
- webhook handling strategy
