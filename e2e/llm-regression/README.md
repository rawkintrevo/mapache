# LLM Regression QA

This directory holds browser QA instructions, scenario manifests, and artifacts for LLM-assisted regression checks.

## QA Login

The hosted app exposes a secret-gated custom-token endpoint at `POST /api/qa/custom-token`. The endpoint only works when Cloud Functions has all of these values configured:

- `QA_LOGIN_SECRET`: Firebase Functions secret used as the shared QA login secret.
- `QA_LOGIN_UID`: Firebase Auth UID for the controlled QA account.
- `QA_LOGIN_EMAIL`: Email address for the controlled QA account.
- `QA_LOGIN_DISPLAY_NAME`: Optional display name for the QA account.

The QA account must also satisfy the normal app access allowlist. If `appConfig/access` is configured, add the QA email or UID there before running browser QA.

For Chrome DevTools QA, set the secret in browser storage before loading the app:

```js
localStorage.setItem("mapache.qaLogin", "1");
localStorage.setItem("mapache.qaSecret", "<QA_LOGIN_SECRET value>");
location.href = "/app?qaLogin=1";
```

The frontend exchanges the secret for a Firebase custom token, signs in with Firebase Auth, and then uses normal authenticated `/api/**` calls. Do not check real QA secrets into this directory.

## Scenario Artifacts

Each run should save screenshots, console output, network failures, browser traces when available, and a structured result JSON with scenario id, status, observations, evidence, and failure reason.
