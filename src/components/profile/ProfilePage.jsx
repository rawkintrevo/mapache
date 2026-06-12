function profileValue(value, fallback = "—") {
  return value ? String(value) : fallback;
}

function userDisplayName(state) {
  return (state.profile && state.profile.displayName) || state.user?.displayName || "User";
}

function userEmail(state) {
  return (state.profile && state.profile.email) || state.user?.email || "";
}

function userPhoto(state) {
  return (state.profile && state.profile.photoURL) || state.user?.photoURL || "";
}

function providerList(state) {
  const ids = state.profile?.providerIds || state.user?.providerData?.map((provider) => provider.providerId) || [];
  return ids.length ? ids.join(", ") : "—";
}

export function ProfilePage({state, onRefresh, onSignOut}) {
  const name = userDisplayName(state);
  const email = userEmail(state);
  const photo = userPhoto(state);

  return (
    <section className="workspace profile-page">
      <div className="profile-card">
        <div className="profile-header">
          {photo ? <img alt="" className="profile-avatar" referrerPolicy="no-referrer" src={photo} /> : null}
          <div>
            <h2>{name}</h2>
            {email ? <p className="subtle">{email}</p> : null}
          </div>
        </div>
        <dl className="profile-details">
          <div>
            <dt>User ID</dt>
            <dd>{profileValue(state.user?.uid || state.profile?.uid)}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{profileValue(email)}</dd>
          </div>
          <div>
            <dt>Sign-in providers</dt>
            <dd>{providerList(state)}</dd>
          </div>
        </dl>
        <div className="profile-actions">
          <button className="secondary" disabled={state.busy} type="button" onClick={onRefresh}>
            {state.busy ? "Working..." : "Refresh profile"}
          </button>
          <button className="secondary" disabled={state.busy} type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}
