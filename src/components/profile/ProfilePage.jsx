import "./ProfilePage.css";
import {ExternalLink, GitBranch, LogOut, RefreshCw, Unplug} from "lucide-react";
import {useState} from "react";
import {Button} from "../common/Button.jsx";

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

function formatUsageNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(number);
}

function formatRuntime(seconds) {
  const number = Number(seconds || 0);
  if (number < 3600) return `${formatUsageNumber(number)} sec`;
  if (number < 86400) return `${formatUsageNumber(number / 3600)} hr`;
  return `${formatUsageNumber(number / 86400)} days`;
}

function formatPoints(value) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function estimatedUsageCost(usage) {
  const cpuSeconds = Number(usage?.cpuSeconds || 0);
  const memoryGbSeconds = Number(usage?.memoryGbSeconds || 0);
  return (cpuSeconds * 0.000018) + (memoryGbSeconds * 0.000002);
}

function estimatedRewardsPoints(usage) {
  return estimatedUsageCost(usage) / 0.003;
}

function githubStatusLabel(status) {
  if (status === "connected") return "Connected";
  if (status === "needs_reauth") return "Needs reauthorization";
  return "Not connected";
}

function githubAccountLabel(connection) {
  return connection?.githubLogin || connection?.displayName || "";
}

function usageMetric(label, value, unit) {
  return (
    <div className="profile-usage-metric">
      <span>{label}</span>
      <strong>{formatUsageNumber(value)}</strong>
      <small>{unit}</small>
    </div>
  );
}

function usageCostMetric(label, value, unit) {
  return (
    <div className="profile-usage-metric profile-usage-metric-cost">
      <span>{label}</span>
      <strong>{formatPoints(value)}</strong>
      <small>
        <a href="https://www.marlboro.com/rewards/redeem" rel="noreferrer" target="_blank">
          {unit}
        </a>
      </small>
    </div>
  );
}

export function ProfilePage({
  state,
  onConnectGithub,
  onDisconnectGithub,
  onRefresh,
  onRefreshGithubRepositories,
  onSignOut,
}) {
  const name = userDisplayName(state);
  const email = userEmail(state);
  const photo = userPhoto(state);
  const usage = state.profile?.usage || {};
  const lifetime = usage.lifetime || {};
  const last30Days = usage.last30Days || {};
  const [usageTab, setUsageTab] = useState("lifetime");
  const activeUsage = usageTab === "last30Days" ? last30Days : lifetime;
  const activeUsageLabel = usageTab === "last30Days" ? "Last 30 Days" : "Lifetime";
  const activeUsagePoints = estimatedRewardsPoints(activeUsage);
  const githubConnection = state.githubConnection || {};
  const githubData = githubConnection.data || {};
  const githubConnected = Boolean(githubData.connected);
  const githubAccount = githubAccountLabel(githubData);
  const githubRepoCount = Array.isArray(state.repoPicker?.repos) ? state.repoPicker.repos.length : 0;
  const githubBusy = state.busy || githubConnection.loading || githubConnection.refreshing || githubConnection.disconnecting;
  const githubPrimaryLabel = githubConnected ? "Restart OAuth" : "Connect GitHub";

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
        <section className="profile-github" aria-labelledby="profile-github-title">
          <div className="profile-section-heading">
            <h3 id="profile-github-title">GitHub</h3>
            {githubAccount ? <p className="subtle">@{githubAccount}</p> : null}
          </div>
          <div className="profile-github-status-row">
            <span className={`profile-github-status profile-github-status-${githubData.connectionStatus || "not_connected"}`}>
              {githubConnection.loading ? "Loading" : githubStatusLabel(githubData.connectionStatus)}
            </span>
            {githubConnected ? (
              <span className="subtle">
                {formatUsageNumber(githubData.installationCount)} installation{githubData.installationCount === 1 ? "" : "s"}
                {githubRepoCount ? `, ${formatUsageNumber(githubRepoCount)} repositories loaded` : ""}
              </span>
            ) : (
              <span className="subtle">No GitHub account connected.</span>
            )}
          </div>
          {githubConnection.error ? <p className="error">{githubConnection.error}</p> : null}
          {githubConnection.message ? <p className="profile-github-message">{githubConnection.message}</p> : null}
          <div className="profile-github-actions">
            <Button disabled={githubBusy} variant="secondary" onClick={onConnectGithub}>
              <GitBranch aria-hidden="true" />
              {githubPrimaryLabel}
            </Button>
            <Button disabled={githubBusy || !githubConnected} variant="secondary" onClick={onRefreshGithubRepositories}>
              <RefreshCw aria-hidden="true" />
              {githubConnection.refreshing || state.repoPicker?.loading ? "Refreshing..." : "Refresh repositories"}
            </Button>
            <a
              className="button button--secondary profile-github-settings-link"
              href="https://github.com/settings/installations"
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" />
              Manage installation
            </a>
            <Button disabled={githubBusy || !githubConnected} variant="secondary" onClick={onDisconnectGithub}>
              <Unplug aria-hidden="true" />
              {githubConnection.disconnecting ? "Disconnecting..." : "Disconnect GitHub"}
            </Button>
          </div>
        </section>
        <section className="profile-usage" aria-labelledby="profile-usage-title">
          <div className="profile-section-heading">
            <h3 id="profile-usage-title">Runner Usage</h3>
            <p className="subtle">Allocated Cloud Run resources from terminal sessions.</p>
          </div>
          <div className="profile-usage-tabs" role="tablist" aria-label="Runner usage ranges">
            <Button
              aria-selected={usageTab === "lifetime"}
              className={usageTab === "lifetime" ? "profile-usage-tab active" : "profile-usage-tab"}
              id="profile-usage-tab-lifetime"
              role="tab"
              variant="secondary"
              onClick={() => setUsageTab("lifetime")}
            >
              Lifetime
            </Button>
            <Button
              aria-selected={usageTab === "last30Days"}
              className={usageTab === "last30Days" ? "profile-usage-tab active" : "profile-usage-tab"}
              id="profile-usage-tab-last30Days"
              role="tab"
              variant="secondary"
              onClick={() => setUsageTab("last30Days")}
            >
              Last 30 Days
            </Button>
          </div>
          <div
            aria-labelledby={usageTab === "last30Days" ? "profile-usage-tab-last30Days" : "profile-usage-tab-lifetime"}
            className="profile-usage-panel"
            role="tabpanel"
          >
            <div className="profile-usage-grid">
              {usageMetric(`${activeUsageLabel} CPU`, activeUsage.cpuSeconds, "vCPU seconds")}
              {usageMetric(`${activeUsageLabel} Memory`, activeUsage.memoryGbSeconds, "GiB seconds")}
              {usageCostMetric("Total Cost", activeUsagePoints, "Marlboro Rewards Points")}
            </div>
          </div>
          <p className="subtle profile-usage-note profile-usage-note-fineprint">
            Runners cost money to leave on, but you are a true friend to rawkintrevo so he&apos;s covering your tab...for now.
          </p>
          <p className="subtle profile-usage-note">
            {usageTab === "last30Days"
              ? `Last 30 Days covers ${formatUsageNumber(last30Days.sessionCount)} sessions and ${formatRuntime(last30Days.runtimeSeconds)} of allocated runtime.`
              : `Lifetime covers ${formatUsageNumber(lifetime.sessionCount)} sessions and ${formatRuntime(lifetime.runtimeSeconds)} of allocated runtime.`}
          </p>
        </section>
        <div className="profile-actions">
          <Button disabled={state.busy} variant="secondary" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            {state.busy ? "Working..." : "Refresh profile"}
          </Button>
          <Button disabled={state.busy} variant="secondary" onClick={onSignOut}>
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>
    </section>
  );
}
