# Security Concerns

- Cloud Run session services are currently made publicly invokable so the hosted app can iframe the terminal without a second identity-token flow.
- The deployed Firebase API Cloud Run service is publicly invokable (`allUsers` has `roles/run.invoker`) so browsers and Firebase Hosting rewrites can reach it. App data access still depends on Firebase ID token checks in function code.
- The terminal runner has no per-request auth check. Anyone with the Cloud Run service URL can reach that session until Cloud Run auth is tightened.
- Terminal history is stored in Firestore and may contain secrets typed or printed in the shell.
- Workspace sync uploads every regular file under `/workspace`; secret files, credentials, and generated artifacts may be copied to Cloud Storage.
- Cloud Functions accepts any Google-authenticated Firebase user. If this project ever has more than one allowed user, add an allowlist check.
- The runner container includes common shell tooling and runs user commands directly. Treat it as arbitrary code execution.
- Firestore rules allow the workspace owner to write terminal history. The runner should eventually write through a service account path that clients cannot mutate.
- Cloud Run service creation grants `allUsers` the invoker role and overwrites the service IAM policy in this scaffold.
- The default compute service account has been granted `roles/run.admin` and `roles/datastore.user` on the project for this prototype. A narrower service account should replace this before adding more users.
- A requested project-level `roles/iam.serviceAccountUser` grant for the default compute service account was not applied because of its broad impersonation risk.
- Resize/restart calls do not rate limit or validate resource choices beyond simple string selection.
