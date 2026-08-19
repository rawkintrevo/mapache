import "./LandingWorkspaceSection.css";
import {SectionEyebrow} from "./LandingSection.jsx";

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
                  <span className="landing-toggle is-on" key={item}>{item}</span>
                ))}
              </dd>
            </div>
            <div>
              <dt>Skills</dt>
              <dd>
                {workspace.skills.map((item) => (
                  <span className="landing-chip" key={item}>{item}</span>
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

export function LandingWorkspaceSection() {
  return (
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
  );
}
