# Mapache Tools Landing Page Blueprint

This blueprint outlines the visual layout, copy, and narrative arc for the Mapache Tools landing page, structured as 5 "snap-to" fullscreen sections.

---

## 🚀 Screen 1: The Hero Jumbotron (The Setup Antidote)

### Narrative Focus
Establish immediate relief from the friction of local environment configuration. A/B test the primary value proposition to see if developers respond more to the frustration of setup or the utility of instant infrastructure.

### Copy
* **Headline Option A (The "Anti-Setup" Angle):** `"Stop configuring your agentic rig. Just code."`
* **Headline Option B (The Infrastructure Angle):** `"Instant, isolated, serverless workspaces for AI agents."`
* **Subheadline:** Skip the dependency hell of local runtimes, conflicting skills, and global auth tokens. Mapache Tools spins up pre-configured container sessions inside sandboxed, Git-linked workspaces in seconds. Built entirely on serverless architecture.

### The Visuals (Animated Jumbotron)
A split-viewport animated GIF or video panel displaying side-by-side terminal behaviors:
* **Left Viewport (Local Setup Hell):** A local terminal running on a Windows/macOS machine drowning in bright red error text. It cycles through `pip install` version conflicts, broken node modules, unmapped system paths, and crashing VS Code extensions.
* **Right Viewport (The Mapache Way):** The Mapache Tools web interface. A user drops in a Git repository URL, clicks a single "Launch Workspace" button, and within 3 seconds, a completely stable environment with a pre-configured coding agent loads and is immediately ready to execute commands.

### Call to Action (CTA)
* `[ Sign Up with Google ]` (Primary Action — routes directly to a clean, blank workspace dashboard)
* `[ Read the Quick Start Docs ]` (Secondary Action — routes to the deployment and user guide)

---

## 🛡️ Screen 2: The Workspace Matrix (Context Isolation)

### Narrative Focus
Address the fundamental limitation of the traditional "local vs. global" machine install paradigm when dealing with multiple agent projects, distinct tooling dependencies, and variable access control.

### Copy
* **Headline:** Project A needs this skill. Project B needs that API key. Your local machine needs a break.
* **Narrative Body:** When you are vibe coding, your local development structure falls apart under the weight of AI agents. You want a specialized skill enabled for one experiment, a specific environment extension for another, and highly sensitive API authentication tokens entirely isolated to a third. Mapache solves this by establishing strictly sandboxed, boundary-mapped Workspaces. No configuration bleeding, no polluted global environments, no accidental credential exposures.

### The Visuals (Interactive Matrix Display)
An interactive comparison layout demonstrating parallel workspace isolation:

```
+------------------------------------+  +------------------------------------+
| WORKSPACE: "FRONTEND UI AGENT"     |  | WORKSPACE: "DATA ANALYSIS AGENT"   |
+------------------------------------+  +------------------------------------+
| [Git Link] repo-ui-generator       |  | [Git Link] autonomous-analytics    |
|                                    |  |                                    |
| [Auth]     Anthropic API Key (ON)  |  | [Auth]     OpenAI API Key (ON)     |
|                                    |  |            Postgres String (ON)    |
|                                    |  |                                    |
| [Skills]   Tailwind UI Injector    |  | [Skills]   Pandas Matrix Wrangler  |
|            CSS Dom Validator       |  |            Matplotlib Exporter     |
+------------------------------------+  +------------------------------------+
| Status: Sandboxed / Inactive       |  | Status: Sandboxed / Active         |
+------------------------------------+  +------------------------------------+
```

---

## ⚡ Screen 3: The Session Engine (The Container Illusion)

### Narrative Focus
Explain the architectural cleverness of Mapache Tools without overwhelming the casual user. Bridge the gap between serverless execution and the stateful feel of dedicated virtual machines.

### Copy
* **Headline:** Parallel container sessions. Zero-latency file overlays.
* **Narrative Body:** Mapache Tools leverages a clever combination of Google Cloud Run instances, purpose-built OCI containers, and cloud storage buckets to create the perfect illusion of an active, heavy developer VM—without the idle-resource bill. Spin up multiple isolated sessions inside a single workspace instantly. Files are mounted via a specialized file overlay network, meaning your manual shell, your automated agents, and your browser views all see file updates simultaneously in real-time.

### The Visuals (Product Interface Spotlight)
A high-fidelity layout showcasing the unified Mapache workspace workspace workspace grid, highlighted with feature tooltips:
1.  **Zone 1 (Left Panel):** An embedded `xterm` shell terminal window running standard Unix commands for direct user control over the underlying sandbox.
2.  **Zone 2 (Center Panel):** A live running `pi-coding-agent` terminal window demonstrating its autonomous execution loop actively scraping, processing, or writing scripts.
3.  **Zone 3 (Right Panel):** A native, modern file explorer sidebar with deep syntax highlighting showing live-updating code structures as the automated agent modifies files.

---

## 🔑 Screen 4: The TUI/WebUI Hybrid (The Auth Center)

### Narrative Focus
Highlight the core UI/UX innovation: wrapping complex terminal config files and credential mappings into simple, visual web interactions.

### Copy
* **Headline:** The raw power of slash commands. The comfort of a clean web sidebar.
* **Narrative Body:** Advanced agentic harnesses are native to the terminal and built around powerful text-driven text-user-interfaces (TUIs). But managing their environment paths, credential variables, and token strings shouldn't require a terminal degree. Mapache embeds full-featured terminal windows for your agent executions, but wraps the configuration logic in human-readable WebUI flows. Store your API keys securely in your global profile once, then easily toggle them on and off for individual workspaces. Mapache automatically formats and injects them onto the virtual disk paths your agents expect to see them.

### The Visuals (UI Focus Mockup)
A close-up view of the Mapache Control Sidebar. The graphic displays an animated mouse cursor toggling a visual switch for an `Anthropic API Key` from **[ OFF ]** to **[ ON ]**. 
An overlaid conceptual flow diagram maps this interaction directly to a virtual file system injection, showing how Mapache silently writes the key to the workspace's local configuration environment variable array without requiring user text entry or `/login` commands.

---

## 🚬 Screen 5: Built in the Open (The Marlboro Counter)

### Narrative Focus
Eradicate SaaS cynicism. Establish an immediate human connection by demonstrating radical cost transparency, open-source building principles, and a casual, personal delivery.

### Copy
* **Headline:** No enterprise markups. Just raw, serverless pennies.
* **Narrative Body:** Mapache Tools isn't a venture-backed startup designed to lock you into an aggressive monthly tier. It is built entirely in the open by a developer who needed a better way to test agents without melting their local rig. We pass through the literal, raw serverless compute and cloud storage pennies it costs to execute your containers—no arbitrary platform markups. 

### The Visuals (The Transparency Dashboard)
A mock-up graphic of the profile page billing tracker, emphasizing the indie-hacker nature of the app:

```
+------------------------------------------------------------------------+
|  MAPACHE TOOLS // USER METRICS PROFILE                                 |
|                                                                        |
|  [||||||||||||||||||||||||||||||||] Last 30 Days Cloud Run Compute      |
|  Actual Google Cloud Cost Passed Through: $2.48                        |
|                                                                        |
|  Current Usage Metric: 845 Marlboro Rewards Points                     |
|                                                                        |
|  --------------------------------------------------------------------  |
|  NOTE: If you are an immediate friend testing this build in early open |
|  access, safely disregard the point tracker—I am picking up the tab.   |
+------------------------------------------------------------------------+
```

### Final Call to Action
* `[ Sign Up via Google ]` — Authorize instantly and jump into a clean, zero-config environment.
* `[ Read the Development Blog & Docs ]` — Check out the open roadmap, source details, and project status updates.
