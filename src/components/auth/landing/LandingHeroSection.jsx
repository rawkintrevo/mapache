import "./LandingHeroSection.css";
import {LandingActions, SectionEyebrow} from "./LandingSection.jsx";

const terminalLines = [
  {kind: "error", text: "ERROR: Cannot install agent-kit==0.7.4 and api-client==2.1.0"},
  {kind: "error", text: "node_modules/.bin/vite: bad interpreter: /usr/local/bin/node"},
  {kind: "error", text: "zsh: command not found: python3.13"},
  {kind: "muted", text: "VS Code extension host terminated unexpectedly"},
];

const mapacheSteps = ["Paste Git repository URL", "Launch Workspace", "pi-coding-agent ready"];

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

export function LandingHeroSection({action, actionLabel}) {
  return (
    <section className="landing-section landing-section--hero" aria-labelledby="landing-hero-title">
      <div className="landing-copy">
        <SectionEyebrow>Serverless agent workspaces</SectionEyebrow>
        <h1 id="landing-hero-title">Stop configuring your agentic rig. Just code.</h1>
        <p>
          Skip the dependency hell of local runtimes, conflicting skills, and global auth tokens. Mapache Tools
          spins up pre-configured container sessions inside sandboxed, Git-linked workspaces in seconds. Built
          entirely on serverless architecture.
        </p>
        <LandingActions action={action} actionLabel={actionLabel} href="/community/docs/intro">
          Read the Quick Start Docs
        </LandingActions>
      </div>
      <HeroVisual />
    </section>
  );
}
