import {FatalError} from "./components/common/FatalError.jsx";
import {LandingPageScreen} from "./components/auth/LandingPageScreen.jsx";
import {AppShell} from "./components/layout/AppShell.jsx";

export function App({appProps, fatalError, isAppRoute, onOpenApp, onSignIn, user}) {
  if (fatalError) {
    return <FatalError error={fatalError} />;
  }

  if (!isAppRoute || !user) {
    return <LandingPageScreen onOpenApp={onOpenApp} onSignIn={onSignIn} user={user} />;
  }

  return <AppShell {...appProps} />;
}
