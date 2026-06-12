import {AuthScreen} from "./components/auth/AuthScreen.jsx";
import {FatalError} from "./components/common/FatalError.jsx";
import {AppShell} from "./components/layout/AppShell.jsx";

export function App({appProps, fatalError, isAppRoute, onOpenApp, onSignIn, user}) {
  if (fatalError) {
    return <FatalError error={fatalError} />;
  }

  if (!isAppRoute || !user) {
    return <AuthScreen onOpenApp={onOpenApp} onSignIn={onSignIn} user={user} />;
  }

  return <AppShell {...appProps} />;
}
