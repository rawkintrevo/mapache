# Mapache Tools

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Hosted app](https://img.shields.io/badge/app-mapache.tools-111827)](https://mapache.tools)
[![Docs](https://img.shields.io/badge/docs-community-2563eb)](https://mapache.tools/community/)
[![Issues](https://img.shields.io/github/issues/rawkintrevo/mapahce)](https://github.com/rawkintrevo/mapahce/issues)
[![GitHub last commit](https://img.shields.io/github/last-commit/rawkintrevo/mapahce)](https://github.com/rawkintrevo/mapahce/commits)
[![GitHub repo size](https://img.shields.io/github/repo-size/rawkintrevo/mapahce)](https://github.com/rawkintrevo/mapahce)
[![Built with React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111827)](https://react.dev/)
[![Built with Firebase](https://img.shields.io/badge/Firebase-hosted-ffca28?logo=firebase&logoColor=111827)](https://firebase.google.com/)
[![Runs on Cloud Run](https://img.shields.io/badge/Cloud_Run-sessions-4285f4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

Browser-managed cloud TUI sessions.

Mapache Tools is the source repository for [mapache.tools](https://mapache.tools), a hosted workspace for launching and managing cloud terminal sessions from the browser.

The project is built in the open. The hosted app is the supported way to use Mapache Tools.

## What It Is

Mapache Tools gives you browser-accessible terminal sessions backed by cloud runtime containers. It is built for fast, disposable, agent-friendly workspaces where the terminal stays central and the browser provides the surrounding controls.

The current product direction is focused on vibe-coding N64 games from cloud TUI sessions. A demo GIF belongs here soon.

## Links

- App: [mapache.tools](https://mapache.tools)
- User docs and blog: [mapache.tools/community](https://mapache.tools/community/)
- Issues and feature requests: [GitHub Issues](https://github.com/rawkintrevo/mapahce/issues)

## Project Status

Mapache Tools is actively developed as the source for the hosted product at [mapache.tools](https://mapache.tools).

Issues, feature requests, and bug reports are welcome. Pull requests are not being accepted at this time.

## Repository Contents

- `src/`: React frontend for the hosted app.
- `functions/`: Firebase Cloud Functions API.
- `session-runner/`: Runtime container code for browser-accessible terminal sessions.
- `community/`: User documentation and blog site served under `/community/`.
- `docs/`: Maintainer-oriented architecture and implementation notes.

## Contact

- Open an issue: [github.com/rawkintrevo/mapahce/issues](https://github.com/rawkintrevo/mapahce/issues)
- Email: [trevor@ata.systems](mailto:trevor@ata.systems)
- Discord: `rawkintrevo`
- Community docs and blog: [mapache.tools/community](https://mapache.tools/community/)

## License

This project is licensed under the terms in [LICENSE](./LICENSE).
