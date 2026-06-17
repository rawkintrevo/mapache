# Mapache Tools

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Hosted app](https://img.shields.io/badge/app-mapache.tools-111827)](https://mapache.tools)
[![Docs](https://img.shields.io/badge/docs-community-2563eb)](https://mapache.tools/community/)
[![Issues](https://img.shields.io/github/issues/rawkintrevo/mapache)](https://github.com/rawkintrevo/mapache/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/rawkintrevo/mapache)](https://github.com/rawkintrevo/mapache/commits)
[![GitHub repo size](https://img.shields.io/github/repo-size/rawkintrevo/mapache)](https://github.com/rawkintrevo/mapache)
[![Built with React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111827)](https://react.dev/)
[![Built with Firebase](https://img.shields.io/badge/Firebase-hosted-ffca28?logo=firebase&logoColor=111827)](https://firebase.google.com/)
[![Runs on Cloud Run](https://img.shields.io/badge/Cloud_Run-sessions-4285f4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

![A raccoon making wise decisions](docs/tools.png)

Browser-managed cloud TUI sessions.

Mapache Tools is the source repository for [mapache.tools](https://mapache.tools), a hosted workspace for launching and managing cloud terminal sessions from the browser.

The project is built in the open. The hosted app is the supported way to use Mapache Tools.

## What It Is

Mapache Tools gives you browser-accessible terminal sessions backed by cloud runtime containers. It is built for fast, disposable, agent-friendly workspaces where the terminal stays central and the browser provides the surrounding controls.

It is useful for cloud-hosted development workflows, agent experiments. Also you can vibe code n64 games to trick your 4 year old into learning stuff. 

## Links

- App: [mapache.tools](https://mapache.tools)
- User docs and blog: [mapache.tools/community](https://mapache.tools/community/)
- Issues and feature requests: [GitHub Issues](https://github.com/rawkintrevo/mapache/issues)

## Project Status

Mapache Tools is actively developed as the source for the hosted product at [mapache.tools](https://mapache.tools).

Issues, feature requests, and bug reports are welcome. Pull requests are not being accepted at this time.

## Repository Contents

- `src/`: React frontend for the hosted app.
- `functions/`: Firebase Cloud Functions API.
- `session-runner/`: Runtime container code for browser-accessible terminal sessions.
- `community/`: User documentation and blog site served under `/community/`.
- `docs/`: Maintainer-oriented architecture and implementation notes.

## Development Checks

Run the default verification suite from the repository root:

```bash
npm run check
```

This runs the Cloud Functions tests, session runner JavaScript syntax checks, and the full app plus community build. It intentionally skips N64 runtime image builds.

## Contact

- Open an issue: [github.com/rawkintrevo/mapache/issues](https://github.com/rawkintrevo/mapache/issues)
- Email: [trevor@ata.systems](mailto:trevor@ata.systems)
- Discord: `rawkintrevo`
- Community docs and blog: [mapache.tools/community](https://mapache.tools/community/)

## License

This project is licensed under the terms in [LICENSE](./LICENSE).
