import "./AuthScreen.css";
import "./LandingPageScreen.css";
import {LandingAuthSection} from "./landing/LandingAuthSection.jsx";
import {LandingEngineSection} from "./landing/LandingEngineSection.jsx";
import {LandingHeroSection} from "./landing/LandingHeroSection.jsx";
import {LandingTransparencySection} from "./landing/LandingTransparencySection.jsx";
import {LandingWorkspaceSection} from "./landing/LandingWorkspaceSection.jsx";

export function LandingPageScreen({onOpenApp, onSignIn, user}) {
  const action = user ? onOpenApp : onSignIn;
  const actionLabel = user ? "Open app" : "Sign up with Google";

  return (
    <div className="auth landing-page">
      <LandingHeroSection action={action} actionLabel={actionLabel} />
      <LandingWorkspaceSection />
      <LandingEngineSection />
      <LandingAuthSection />
      <LandingTransparencySection action={action} actionLabel={actionLabel} />
    </div>
  );
}
