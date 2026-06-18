import "./AdminPage.css";
import {ChevronLeft, ChevronRight, RefreshCw} from "lucide-react";
import {Button} from "../common/Button.jsx";

function userLabel(user) {
  return user.displayName || user.email || user.uid || "Unknown user";
}

function formatCurrency(value) {
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: 4,
    style: "currency",
  }).format(Number(value || 0));
}

export function AdminPage({
  state,
  onNextPage,
  onPreviousPage,
  onRefresh,
  onSetWhitelisted,
}) {
  const admin = state.admin || {};
  const users = admin.users || [];
  const hasPrevious = Boolean(admin.cursorStack && admin.cursorStack.length);
  const hasNext = Boolean(admin.nextCursor);

  return (
    <section className="workspace admin-page">
      <div className="admin-page__header">
        <div>
          <h2>Admin</h2>
          <p className="subtle">Users, allowlist status, and allocated runner cost.</p>
        </div>
        <Button disabled={state.busy || admin.loading} variant="secondary" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          {admin.loading ? "Loading..." : "Refresh"}
        </Button>
      </div>

      {admin.error ? <p className="error">{admin.error}</p> : null}

      <div className="admin-table-wrap">
        <table className="admin-users-table">
          <thead>
            <tr>
              <th scope="col">White Listed</th>
              <th scope="col">Display Name</th>
              <th scope="col">Lifetime Cost</th>
              <th scope="col">Last 30 Days Cost</th>
              <th scope="col">User Type</th>
            </tr>
          </thead>
          <tbody>
            {users.length ? users.map((user) => (
              <tr key={user.uid}>
                <td>
                  <label className="admin-switch">
                    <input
                      aria-label={`White list ${userLabel(user)}`}
                      checked={user.whitelisted === true}
                      disabled={state.busy || admin.loading}
                      name={`whitelist-${user.uid}`}
                      type="checkbox"
                      onChange={(event) => onSetWhitelisted(user.uid, event.target.checked)}
                    />
                    <span aria-hidden="true" />
                  </label>
                </td>
                <td>
                  <div className="admin-user-cell">
                    <strong>{userLabel(user)}</strong>
                    {user.email && user.email !== userLabel(user) ? <span>{user.email}</span> : null}
                  </div>
                </td>
                <td>{formatCurrency(user.costs?.lifetimeUsd)}</td>
                <td>{formatCurrency(user.costs?.last30DaysUsd)}</td>
                <td>
                  <select
                    aria-label={`User type for ${userLabel(user)}`}
                    className="admin-user-type"
                    disabled
                    name={`user-type-${user.uid}`}
                    value={user.userType || "not-set"}
                  >
                    <option value="not-set">Not Set</option>
                  </select>
                </td>
              </tr>
            )) : (
              <tr>
                <td className="admin-empty" colSpan="5">
                  {admin.loading ? "Loading users..." : "No users found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="admin-pagination">
        <Button disabled={!hasPrevious || state.busy || admin.loading} variant="secondary" onClick={onPreviousPage}>
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <span className="subtle">{users.length} users</span>
        <Button disabled={!hasNext || state.busy || admin.loading} variant="secondary" onClick={onNextPage}>
          Next
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
