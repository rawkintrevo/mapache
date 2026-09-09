import "./LandingEngineSection.css";
import {SectionEyebrow} from "./LandingSection.jsx";

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

export function LandingEngineSection() {
  return (
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
  );
}
