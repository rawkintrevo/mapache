import "./LandingTransparencySection.css";
import {LandingActions, SectionEyebrow} from "./LandingSection.jsx";

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

export function LandingTransparencySection({action, actionLabel}) {
  return (
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
        <LandingActions action={action} actionLabel={actionLabel} href="/community/blog">
          Read the Development Blog &amp; Docs
        </LandingActions>
      </div>
      <TransparencyVisual />
    </section>
  );
}
