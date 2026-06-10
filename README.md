# Mapache Tools

Firebase + Cloud Run scaffold for browser-managed cloud terminal sessions.

## License

This repository is licensed under Business Source License 1.1. See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for the project notice. The current change date is June 10, 2030, after which the code converts to GNU AGPLv3-or-later.

## Deployed at

https://pi-agents-cloud.web.app/

## Pieces

- Firebase Hosting serves the Vite-built console from `dist/`.
- Firebase Auth uses Google sign-in.
- Firestore stores user profiles, workspaces, sessions, and terminal history.
- Cloud Functions exposes `/api/**` for workspace/session management.
- `session-runner/` is the Cloud Run container that serves a WebSocket terminal and syncs `/workspace` to Cloud Storage.

## Required setup

1. Enable these APIs in the `pi-agents-cloud` Google Cloud project:
   - Cloud Run Admin API
   - Cloud Build API
   - Artifact Registry API
   - Firestore API
   - Cloud Storage API

2. Create or choose a Storage bucket for workspace files.

3. Build and push the runner image:

   ```bash
   gcloud artifacts repositories create pi-agents --repository-format=docker --location=us-central1
   gcloud builds submit session-runner --tag us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
   ```

   To publish the optional `pi-basic` runtime shown in the session image
   dropdown:

   ```bash
   gcloud builds submit session-runner --config session-runner/cloudbuild.pi-basic.yaml
   ```

4. Configure Functions environment variables in `functions/.env`:

   ```bash
   SESSION_RUNNER_IMAGE=us-central1-docker.pkg.dev/pi-agents-cloud/pi-agents/session-runner:latest
   SESSION_BUCKET=YOUR_BUCKET_NAME
   SESSION_REGION=us-central1
   ```

   `functions/.env` is ignored by git by default.

5. Give the Functions service account permissions:

   ```bash
   gcloud projects add-iam-policy-binding pi-agents-cloud \
     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role="roles/run.admin"
   gcloud projects add-iam-policy-binding pi-agents-cloud \
     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser"
   ```

6. Give the Cloud Run runtime service account access to Firestore and Storage:

   ```bash
   gcloud projects add-iam-policy-binding pi-agents-cloud \
     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role="roles/datastore.user"
   gsutil iam ch serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com:objectAdmin gs://YOUR_BUCKET_NAME
   ```

7. Deploy:

   ```bash
   firebase deploy
   ```

## Local development

Install root dependencies and start the Vite frontend:

```bash
npm install
npm run dev
```

By default, the local Vite server proxies `/api/**` to the deployed Firebase
Hosting API at `https://pi-agents-cloud.web.app`, so login and workspace calls
work without local emulators.

To use the Firebase Functions emulator instead:

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:5001/pi-agents-cloud/us-central1/api npm run dev
```

For local Vite auth config, create `.env.local` with:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=pi-agents-cloud.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=pi-agents-cloud
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

When deployed to Firebase Hosting, the app falls back to `/__/firebase/init.json`.

Run the Firebase emulators:

```bash
firebase emulators:start
```

Run the terminal runner locally:

```bash
cd session-runner
npm install
STORAGE_BUCKET=YOUR_BUCKET_NAME STORAGE_PREFIX=workspaces/dev/default WORKSPACE_ID=dev SESSION_ID=dev npm start
```

## Notes

`SESSION_RUNNER_IMAGE` and `SESSION_BUCKET` are intentionally read from environment variables. If `SESSION_RUNNER_IMAGE` is missing, session records are still created with `needs_image` status so the UI can be tested before Cloud Run provisioning is configured.
