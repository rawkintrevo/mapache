import {AuthScreen} from "./components/auth/AuthScreen.jsx";
import {FatalError} from "./components/common/FatalError.jsx";
import {AppShell} from "./components/layout/AppShell.jsx";

export function App({appProps, fatalError, onSignIn, user}) {
  if (fatalError) {
    return <FatalError error={fatalError} />;
  }

  if (!user) {
    return <AuthScreen onSignIn={onSignIn} />;
  }

  return <AppShell {...appProps} />;
}
