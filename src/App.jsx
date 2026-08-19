import {lazy, Suspense} from "react";
import {LazySurfaceFallback} from "./components/common/LazySurfaceFallback.jsx";
import {FatalError} from "./components/common/FatalError.jsx";
import {AppShell} from "./components/layout/AppShell.jsx";

const LandingPageScreen = lazy(() => import("./components/auth/LandingPageScreen.jsx").then(({LandingPageScreen: page}) => ({default: page})));

export function App({appProps, fatalError, isAppRoute, onOpenApp, onSignIn, user}) {
  if (fatalError) {
    return <FatalError error={fatalError} />;
  }

  if (!isAppRoute || !user) {
    return (
      <Suspense fallback={<LazySurfaceFallback label="Loading landing page..." />}>
        <LandingPageScreen onOpenApp={onOpenApp} onSignIn={onSignIn} user={user} />
      </Suspense>
    );
  }

  return <AppShell {...appProps} />;
}
