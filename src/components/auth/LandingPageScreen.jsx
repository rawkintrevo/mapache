import {Button} from "../common/Button.jsx";

const workspaceCards = [
  {
    auth: ["Anthropic API Key"],
    repo: "repo-ui-generator",
    skills: ["Tailwind UI Injector", "CSS DOM Validator"],
    status: "Sandboxed / Inactive",
    title: "Frontend UI Agent",
  },
  {
    auth: ["OpenAI API Key", "Postgres String"],
    repo: "autonomous-analytics",
    skills: ["Pandas Matrix Wrangler", "Matplotlib Exporter"],
    status: "Sandboxed / Active",
    title: "Data Analysis Agent",
  },
];

const terminalLines = [
  {kind: "error", text: "ERROR: Cannot install agent-kit==0.7.4 and api-client==2.1.0"},
  {kind: "error", text: "node_modules/.bin/vite: bad interpreter: /usr/local/bin/node"},
  {kind: "error", text: "zsh: command not found: python3.13"},
  {kind: "muted", text: "VS Code extension host terminated unexpectedly"},
];

const mapacheSteps = ["Paste Git repository URL", "Launch Workspace", "pi-coding-agent ready"];

function SectionEyebrow({children}) {
  return <p className="landing-eyebrow">{children}</p>;
}

function HeroVisual() {
  return (
    <div className="landing-hero-visual" aria-label="Comparison of local setup failures and Mapache workspace launch">
      <div className="landing-terminal landing-terminal--broken">
        <div className="landing-terminal__bar">
          <span />
          <span />
          <span />
        </div>
        <p className="landing-terminal__label">Local setup</p>
        {terminalLines.map((line) => (
          <code className={`landing-terminal__line landing-terminal__line--${line.kind}`} key={line.text}>
            {line.text}
          </code>
        ))}
      </div>
      <div className="landing-terminal landing-terminal--ready">
        <div className="landing-terminal__bar">
          <span />
          <span />
          <span />
        </div>
        <p className="landing-terminal__label">Mapache Tools</p>
        <div className="landing-launch-card">
          <span>Git repository</span>
          <strong>github.com/team/agent-workbench</strong>
          <button type="button">Launch Workspace</button>
        </div>
        <ol className="landing-steps" aria-label="Workspace launch steps">
          {mapacheSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function WorkspaceMatrix() {
  return (
    <div className="landing-matrix" aria-label="Parallel isolated workspace comparison">
      {workspaceCards.map((workspace) => (
        <article className="landing-workspace-card" key={workspace.title}>
          <header>
            <span>Workspace</span>
            <h3>{workspace.title}</h3>
          </header>
          <dl>
            <div>
              <dt>Git link</dt>
              <dd>{workspace.repo}</dd>
            </div>
            <div>
              <dt>Auth</dt>
              <dd>
                {workspace.auth.map((item) => (
                  <span className="landing-toggle is-on" key={item}>
                    {item}
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt>Skills</dt>
              <dd>
                {workspace.skills.map((item) => (
                  <span className="landing-chip" key={item}>
                    {item}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
          <footer>{workspace.status}</footer>
        </article>
      ))}
    </div>
  );
}

function SessionEngineVisual() {
  return (
    <div className="landing-product" aria-label="Workspace interface with terminal, agent, and file explorer">
      <section className="landing-product__panel landing-product__panel--shell">
        <span>Manual shell</span>
        <code>$ npm test</code>
        <code>$ git status --short</code>
        <code className="is-success">clean workspace</code>
      </section>
      <section className="landing-product__panel landing-product__panel--agent">
        <span>pi-coding-agent</span>
        <code>reading task context...</code>
        <code>editing src/workflows/git.js</code>
        <code className="is-success">verification passed</code>
      </section>
      <section className="landing-product__panel landing-product__panel--files">
        <span>Live files</span>
        <ul>
          <li>src/</li>
          <li>components/</li>
          <li className="is-active">LandingPageScreen.jsx</li>
          <li>styles.css</li>
        </ul>
      </section>
      <p className="landing-tooltip landing-tooltip--one">Cloud Run session</p>
      <p className="landing-tooltip landing-tooltip--two">Shared file overlay</p>
      <p className="landing-tooltip landing-tooltip--three">Browser-visible updates</p>
    </div>
  );
}

function AuthCenterVisual() {
  return (
    <div className="landing-auth-visual" aria-label="Authentication Center toggle maps credentials into workspace files">
      <section className="landing-auth-sidebar">
        <span>Authentication Center</span>
        <div className="landing-auth-row">
          <p>
            <strong>Anthropic API Key</strong>
            <small>workspace scoped</small>
          </p>
          <span className="landing-switch" aria-hidden="true">
            <span />
          </span>
        </div>
        <div className="landing-auth-row">
          <p>
            <strong>OpenAI API Key</strong>
            <small>available in profile</small>
          </p>
          <span className="landing-switch landing-switch--off" aria-hidden="true">
            <span />
          </span>
        </div>
      </section>
      <section className="landing-auth-flow">
        <code>Profile secret store</code>
        <span />
        <code>/workspace/.pi/agent/auth.json</code>
        <span />
        <code>ANTHROPIC_API_KEY=enabled</code>
      </section>
    </div>
  );
}

function TransparencyVisual() {
  return (
    <div className="landing-open-carousel" aria-label="Transparent usage screenshot and Marlboro rewards comparison">
      <div className="landing-open-carousel__track">
        <figure className="landing-open-carousel__slide">
          <img src="/usage_screenshot.jpg" alt="Mapache Tools runner usage metrics screen" />
          <figcaption>Actual runner usage screen</figcaption>
        </figure>
        <figure className="landing-open-carousel__slide">
          <img src="/marlboro_velomobile.jpg" alt="Marlboro Rewards velomobile redemption image" />
          <figcaption>Marlboro Rewards conversion benchmark</figcaption>
        </figure>
      </div>
    </div>
  );
}

export function LandingPageScreen({onOpenApp, onSignIn, user}) {
  const action = user ? onOpenApp : onSignIn;
  const actionLabel = user ? "Open app" : "Sign up with Google";

  return (
    <div className="auth landing-page">
      <section className="landing-section landing-section--hero" aria-labelledby="landing-hero-title">
        <div className="landing-copy">
          <SectionEyebrow>Serverless agent workspaces</SectionEyebrow>
          <h1 id="landing-hero-title">Stop configuring your agentic rig. Just code.</h1>
          <p>
            Skip the dependency hell of local runtimes, conflicting skills, and global auth tokens. Mapache Tools
            spins up pre-configured container sessions inside sandboxed, Git-linked workspaces in seconds. Built
            entirely on serverless architecture.
          </p>
          <div className="landing-actions">
            <Button onClick={action}>{actionLabel}</Button>
            <a className="button button--secondary" href="/community/docs/intro">
              Read the Quick Start Docs
            </a>
          </div>
        </div>
        <HeroVisual />
      </section>

      <section className="landing-section landing-section--matrix" aria-labelledby="landing-matrix-title">
        <div className="landing-copy">
          <SectionEyebrow>Context isolation</SectionEyebrow>
          <h2 id="landing-matrix-title">
            Project A needs this skill. Project B needs that API key. Your local machine needs a break.
          </h2>
          <p>
            When you are vibe coding, your local development structure falls apart under the weight of AI agents.
            Mapache establishes strictly sandboxed, boundary-mapped workspaces: no configuration bleeding, no polluted
            global environments, no accidental credential exposures.
          </p>
        </div>
        <WorkspaceMatrix />
      </section>

      <section className="landing-section landing-section--engine" aria-labelledby="landing-engine-title">
        <div className="landing-copy">
          <SectionEyebrow>Session engine</SectionEyebrow>
          <h2 id="landing-engine-title">Parallel container sessions. Zero-latency file overlays.</h2>
          <p>
            Mapache combines Google Cloud Run instances, purpose-built OCI containers, and cloud storage buckets to
            create the feel of an active developer VM without the idle-resource bill. Manual shells, automated agents,
            and browser views see file updates together in real time.
          </p>
        </div>
        <SessionEngineVisual />
      </section>

      <section className="landing-section landing-section--auth" aria-labelledby="landing-auth-title">
        <div className="landing-copy">
          <SectionEyebrow>TUI/WebUI hybrid</SectionEyebrow>
          <h2 id="landing-auth-title">The raw power of slash commands. The comfort of a clean web sidebar.</h2>
          <p>
            Advanced agent harnesses belong in terminal windows, but credentials should not require a terminal degree.
            Store API keys securely in your global profile once, then toggle them per workspace while Mapache formats
            and injects the files and variables your agents expect.
          </p>
        </div>
        <AuthCenterVisual />
      </section>

      <section className="landing-section landing-section--open" aria-labelledby="landing-open-title">
        <div className="landing-copy landing-open-copy">
          <p className="landing-eyebrow landing-open-copy__rotator">
            <span className="landing-open-copy__item landing-open-copy__item--usage">Built in the open</span>
            <span className="landing-open-copy__item landing-open-copy__item--velomobile">
              Help me realize my dream
            </span>
          </p>
          <h2 id="landing-open-title" className="landing-open-copy__rotator">
            <span className="landing-open-copy__item landing-open-copy__item--usage">
              No enterprise markups. Just raw, serverless pennies.
            </span>
            <span className="landing-open-copy__item landing-open-copy__item--velomobile">
              The Marlboro Rally Cross Velomobile
            </span>
          </h2>
          <p className="landing-open-copy__rotator landing-open-copy__body">
            <span className="landing-open-copy__item landing-open-copy__item--usage">
              Mapache Tools is built in the open by a developer who needed a better way to test agents without melting a
              local rig. The product tracks the literal serverless compute and storage it costs to run your containers,
              without arbitrary platform markups.
            </span>
            <span className="landing-open-copy__item landing-open-copy__item--velomobile">
              To be clear this is not an actual Marlboro Bucks Prize (I don't smoke anymore and when I did I smoked
              Lucky Strikes) but an actual dream I had where a wierd naked Native American guided me through the desert
              where I met Jim Morrison who instructed me to bribe Marbalro to give me a rally cross velomobile.
            </span>
          </p>
          <div className="landing-actions">
            <Button onClick={action}>{actionLabel}</Button>
            <a className="button button--secondary" href="/community/blog">
              Read the Development Blog & Docs
            </a>
          </div>
        </div>
        <TransparencyVisual />
      </section>
    </div>
  );
}
