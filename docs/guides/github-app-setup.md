# GitHub App Setup Guide

This guide walks you through creating the GitHub App that Pi Agents Cloud uses for private-repo support, repo picking, and PR creation.

## Prerequisites

- A GitHub account with access to the organization or account that will own the app
- Access to the Firebase/Google Cloud project where secrets will be stored

## Step 1: Open GitHub Developer Settings

1. Go to [github.com](https://github.com) and sign in.
2. Click your profile picture (top right) → **Settings**.
3. In the left sidebar, scroll to the bottom and click **Developer settings**.
4. Click **GitHub Apps** in the left sidebar.
5. Click the **New GitHub App** button.

## Step 2: Fill in Basic App Information

Fill in the registration form:

- **GitHub App name**: `Pi Agents Cloud`
- **Description**: `Pi Agents Cloud workspace connector for GitHub repositories`
- **Homepage URL**: `https://pi-agents-cloud.web.app` (or your deployed Firebase Hosting URL)
- **Callback URL**: leave blank for now (will be configured later when OAuth routes exist)
- **Setup URL**: leave blank
- **Webhook URL**: leave blank for now (or enter a placeholder)
- **Webhook secret**: click **Generate a new client secret** and copy it immediately (store it securely)

## Step 3: Choose Permissions

Under **Permissions**, expand **Repository permissions** and set:

| Permission | Access |
|------------|--------|
| Contents | Read & write |
| Metadata | Read-only (default) |
| Pull requests | Read & write |

Under **Organization permissions**, leave everything at default (no access).

Under **User permissions**, set:

| Permission | Access |
|------------|--------|
| Email addresses | Read-only |

## Step 4: Choose Repository Access Scope

Under **Where can this GitHub App be installed?**, select:

- **Any account** (allows installations on any repository the user has access to)

This corresponds to the policy decision to support all repositories, not just a pre-selected list.

## Step 5: Create the App

Click **Create GitHub App**.

After creation, GitHub redirects you to the app management page. You will need three values from this page:

- **App ID** (numeric, near the top)
- **Client ID** (alphanumeric string)
- **Client secret** (if you generated one earlier)

Record these values in a secure location (not in this repository). They will be needed for Firebase secrets configuration.

## Step 6: Generate a Private Key

1. On the app management page, scroll to **Private keys**.
2. Click **Generate a private key**.
3. GitHub downloads a `.pem` file immediately.
4. Move the file to a secure location (e.g., your password manager or a cloud secret manager).
5. Do not commit the `.pem` file to version control.

The private key is used by the backend to mint short-lived installation tokens.

## Step 7: Install the App

1. On the app management page, click **Install App** in the left sidebar.
2. Select the organization or account where you want to install it.
3. Choose **All repositories** (to match the chosen scope policy).
4. Click **Install**.

After installation, note the **Installation ID** in the URL (`https://github.com/settings/installations/<installation-id>`). Record this securely as well.

## Step 8: Store Secrets for Firebase / Cloud Functions

Use the Firebase CLI or Google Cloud Secret Manager to store the following values:

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_WEBHOOK_SECRET`

Example using Firebase Functions secrets:

```bash
firebase functions:secrets:set GITHUB_APP_ID --project pi-agents-cloud
firebase functions:secrets:set GITHUB_APP_CLIENT_ID --project pi-agents-cloud
firebase functions:secrets:set GITHUB_APP_CLIENT_SECRET --project pi-agents-cloud
firebase functions:secrets:set GITHUB_APP_PRIVATE_KEY --project pi-agents-cloud
firebase functions:secrets:set GITHUB_APP_WEBHOOK_SECRET --project pi-agents-cloud
```

Alternatively, store them in Google Cloud Secret Manager and reference them in your Cloud Functions environment.

## Step 9: Configure Callback and Webhook URLs (when ready)

When the backend OAuth callback route exists:

- **Callback URL**: `https://pi-agents-cloud.web.app/api/github/callback`
- **Webhook URL**: `https://<region>-pi-agents-cloud.cloudfunctions.net/api/github/webhook`

Update these in the GitHub App settings before going live.

## Step 10: Verify

Test that the app is accessible:

1. Go to the app page (`https://github.com/apps/<app-name>`).
2. Confirm the installation shows on the target organization/account.
3. Confirm the private key is stored securely and retrievable by the Cloud Functions deployment.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| App not showing in installations | Check that you clicked **Install App** and completed the flow |
| Private key lost | Generate a new one in the app settings and delete the old one |
| Permission errors later | Re-check the permission list; GitHub Apps require reinstall after permission changes |
| Webhook delivery failures | Verify the webhook URL is reachable and the secret matches |

## Next Steps

After setup is complete, continue with:

- [Task 27: Configure GitHub App secrets for Firebase/Cloud Functions](../task_list.md)
- [Task 28: Install the GitHub App on a test repository](../task_list.md)
