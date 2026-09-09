import "./LandingAuthSection.css";
import {SectionEyebrow} from "./LandingSection.jsx";

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
          <span className="landing-switch" aria-hidden="true"><span /></span>
        </div>
        <div className="landing-auth-row">
          <p>
            <strong>OpenAI API Key</strong>
            <small>available in profile</small>
          </p>
          <span className="landing-switch landing-switch--off" aria-hidden="true"><span /></span>
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

export function LandingAuthSection() {
  return (
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
  );
}
