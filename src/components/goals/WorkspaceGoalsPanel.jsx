import {useEffect, useMemo, useState} from "react";
import "./WorkspaceGoalsPanel.css";
import {Button} from "../common/Button.jsx";
import {sessionHarness} from "../../utils/sessionHarnesses.js";

const EMPTY_FORM = {title: "", objective: "", mode: "regular", auditEnabled: true};

export function WorkspaceGoalsPanel({api, initialSessionId = "", sessions = [], workspaceId}) {
  const [goals, setGoals] = useState([]);
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyGoalId, setBusyGoalId] = useState("");
  const [sessionSelections, setSessionSelections] = useState({});
  const [runtimeByGoal, setRuntimeByGoal] = useState({});
  const [answerDrafts, setAnswerDrafts] = useState({});
  const [answeringRequestId, setAnsweringRequestId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [terminalHandoff, setTerminalHandoff] = useState(null);

  const compatibleSessions = useMemo(() => sessions.filter((session) => {
    return sessionHarness(session)?.id === "pi" && session.serviceUrl &&
      ["running", "restarting", "resizing"].includes(String(session.status || "").toLowerCase());
  }), [sessions]);

  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) || goals[0] || null;
  const runtimeResponse = selectedGoal ? runtimeByGoal[selectedGoal.id] : null;
  const selectedRuntime = runtimeResponse?.runtime || runtimeResponse;
  const defaultSessionId = compatibleSessions.some((session) => session.id === initialSessionId) ?
    initialSessionId : compatibleSessions[0]?.id || "";

  function sessionIdForGoal(goal) {
    return sessionSelections[goal.id] ?? (goal.assignedSessionId || defaultSessionId);
  }

  useEffect(() => {
    let active = true;
    if (!api || !workspaceId || typeof api.listGoals !== "function") return undefined;
    setLoading(true);
    setError("");
    api.listGoals(workspaceId)
        .then((result) => {
          if (!active) return;
          const nextGoals = Array.isArray(result?.goals) ? result.goals : [];
          setGoals(nextGoals);
          setSelectedGoalId((current) => nextGoals.some((goal) => goal.id === current) ? current : nextGoals[0]?.id || "");
        })
        .catch((cause) => {
          if (active) setError(friendlyGoalError(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => { active = false; };
  }, [api, workspaceId]);

  useEffect(() => {
    let active = true;
    let timer;
    const loadRuntime = async () => {
      if (!api || !workspaceId || !selectedGoal?.assignedSessionId || typeof api.getGoalRuntime !== "function") return;
      try {
        const runtime = await api.getGoalRuntime(workspaceId, selectedGoal.id);
        if (active) setRuntimeByGoal((current) => ({...current, [selectedGoal.id]: runtime}));
      } catch (cause) {
        if (active && !["goal_not_assigned", "no_active_session", "goal_bridge_unavailable"].includes(String(cause?.message || ""))) {
          setError(friendlyGoalError(cause));
        }
      } finally {
        if (active) timer = window.setTimeout(loadRuntime, 2500);
      }
    };
    loadRuntime();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [api, workspaceId, selectedGoal?.id, selectedGoal?.assignedSessionId]);

  async function refresh({preserveError = false} = {}) {
    if (!api || !workspaceId) return;
    setLoading(true);
    if (!preserveError) setError("");
    try {
      const result = await api.listGoals(workspaceId);
      const nextGoals = Array.isArray(result?.goals) ? result.goals : [];
      setGoals(nextGoals);
      setSelectedGoalId((current) => nextGoals.some((goal) => goal.id === current) ? current : nextGoals[0]?.id || "");
    } catch (cause) {
      setError(friendlyGoalError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function saveGoal(event) {
    event.preventDefault();
    if (!form.objective.trim() || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const goal = await api.createGoal(workspaceId, {
        title: form.title.trim() || undefined,
        objective: form.objective.trim(),
        mode: form.mode,
        auditEnabled: form.auditEnabled,
      });
      setGoals((current) => [goal, ...current]);
      setSelectedGoalId(goal.id);
      setSessionSelections((current) => ({...current, [goal.id]: defaultSessionId}));
      setForm(EMPTY_FORM);
      setShowForm(false);
      setMessage("Goal saved. Choose a Pi session when you are ready to start it.");
    } catch (cause) {
      setError(friendlyGoalError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function runAction(goal, action, extra = {}) {
    if (!goal || busyGoalId) return;
    let sessionId = extra.sessionId;
    if (["start", "resume"].includes(action) && !sessionId) {
      setError("Start a running Pi session first, then select it here.");
      return;
    }
    setTerminalHandoff(null);
    setBusyGoalId(goal.id);
    setError("");
    setMessage("");
    try {
      const result = await api.actionGoal(workspaceId, goal.id, {
        action,
        sessionId,
        expectedRevision: goal.revision,
        operationId: `${goal.id}-${action}-${Date.now()}`,
        ...extra,
      });
      if (result?.goal) setGoals((current) => current.map((item) => item.id === goal.id ? result.goal : item));
      if (typeof api.getGoalRuntime === "function" && (result?.goal?.assignedSessionId || goal.assignedSessionId)) {
        const runtime = await api.getGoalRuntime(workspaceId, goal.id).catch(() => null);
        if (runtime) setRuntimeByGoal((current) => ({...current, [goal.id]: runtime}));
      }
      setMessage(action === "start" ? "Goal accepted by the Pi runner." : `Goal ${action} accepted.`);
    } catch (cause) {
      setError(friendlyGoalError(cause));
      if (cause?.message === "goal_terminal_process_active") {
        if (extra.takeOverTerminal) {
          setError("This session needs the updated Goal controls. Restart the session to load the latest Pi image, then try again.");
        } else {
          setTerminalHandoff({goalId: goal.id, action, sessionId});
        }
      }
      await refresh({preserveError: true});
    } finally {
      setBusyGoalId("");
    }
  }

  async function answerUiRequest(goal, request, answer) {
    if (!goal || !request || !answer.trim() || answeringRequestId) return;
    setAnsweringRequestId(request.id);
    setError("");
    try {
      const result = await api.answerGoalQuestion(workspaceId, goal.id, request.id, {
        requestId: request.id,
        answer,
        expectedRevision: goal.revision || 0,
      });
      const updatedGoal = result?.goal || (typeof api.getGoal === "function" ? await api.getGoal(workspaceId, goal.id) : null);
      if (updatedGoal) setGoals((current) => current.map((item) => item.id === goal.id ? updatedGoal : item));
      setAnswerDrafts((current) => ({...current, [request.id]: ""}));
      const runtime = await api.getGoalRuntime(workspaceId, goal.id).catch(() => null);
      if (runtime) setRuntimeByGoal((current) => ({...current, [goal.id]: runtime}));
    } catch (cause) {
      setError(friendlyGoalError(cause));
    } finally {
      setAnsweringRequestId("");
    }
  }

  if (!workspaceId) return null;

  return (
    <section className="workspace-goals" aria-labelledby="workspace-goals-title">
      <div className="workspace-goals__header">
        <div>
          <h2 id="workspace-goals-title">Goals</h2>
          <p className="subtle">Save objectives for this workspace and resume them from a Pi session.</p>
        </div>
        <div className="workspace-goals__header-actions">
          <Button variant="secondary" type="button" onClick={() => refresh()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
          <Button type="button" onClick={() => setShowForm((current) => !current)}>
            {showForm ? "Close" : "New goal"}
          </Button>
        </div>
      </div>

      {error ? <div className="error" role="alert">{error}</div> : null}
      {message ? <div className="workspace-goals__message" role="status">{message}</div> : null}

      {showForm ? (
        <form className="workspace-goals__form" onSubmit={saveGoal}>
          <label>Title (optional)<input value={form.title} maxLength={160} onChange={(event) => setForm({...form, title: event.target.value})} /></label>
          <label>Objective<textarea required value={form.objective} maxLength={4000} rows={4} placeholder="Describe the outcome this workspace should achieve." onChange={(event) => setForm({...form, objective: event.target.value})} /></label>
          <label>Goal style<select value={form.mode} onChange={(event) => setForm({...form, mode: event.target.value})}><option value="regular">Regular: Pi chooses the plan</option><option value="sisyphus">Sisyphus: follow an ordered plan</option></select></label>
          <label className="workspace-goals__checkbox"><input type="checkbox" checked={form.auditEnabled} onChange={(event) => setForm({...form, auditEnabled: event.target.checked})} /> Use independent completion audit</label>
          <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save goal"}</Button>
        </form>
      ) : null}

      {!goals.length && !loading ? <p className="empty">No saved goals yet.</p> : null}
      <div className="workspace-goals__list">
        {goals.map((goal) => (
          <article className={`workspace-goal-card ${selectedGoal?.id === goal.id ? "selected" : ""}`} key={goal.id}>
            <button className="workspace-goal-card__select" type="button" onClick={() => { setSelectedGoalId(goal.id); setTerminalHandoff(null); }}>
              <span className="workspace-goal-card__title">{goal.title}</span>
              <span className="pill">{goal.lifecycle || "draft"}</span>
              <span className="subtle">{goal.mode || "regular"} · revision {goal.revision || 0}</span>
            </button>
            {selectedGoal?.id === goal.id ? (
              <div className="workspace-goal-card__details">
                <p>{goal.objective}</p>
                <div className="workspace-goal-card__meta">
                  <span>Tasks: {goal.taskCounts?.completed || 0}/{goal.taskCounts?.total || 0} complete</span>
                  <span>{goal.assignedSessionId ? `Session ${goal.assignedSessionId}` : "No session assigned"}</span>
                  {goal.checkpoint?.savedAt ? <span>Saved {formatDate(goal.checkpoint.savedAt)}</span> : null}
                </div>
                {selectedRuntime ? (
                  <div className="workspace-goals__runtime" aria-live="polite">
                    <p><strong>{runtimeStatusLabel(selectedRuntime.status)}</strong></p>
                    {selectedRuntime.lastError ? <p className="error" role="alert">{selectedRuntime.lastError}</p> : null}
                    {selectedRuntime.lastMessage ? <p>{selectedRuntime.lastMessage}</p> : null}
                  </div>
                ) : null}
                {terminalHandoff?.goalId === goal.id ? (
                  <div className="workspace-goals__handoff">
                    <p>Switching to Goal control stops Pi in Terminal/Chat and interrupts any work there. Saved conversation history and workspace files are kept.</p>
                    <Button disabled={Boolean(busyGoalId)} onClick={() => runAction(goal, terminalHandoff.action, {sessionId: terminalHandoff.sessionId, takeOverTerminal: true})}>
                      Stop Terminal/Chat and {terminalHandoff.action === "start" ? "start" : "resume"} goal
                    </Button>
                  </div>
                ) : null}
                {selectedRuntime?.pendingUiRequests?.length ? (
                  <div className="workspace-goals__dialogs" aria-label="Pi needs your input">
                    <strong>Pi needs your input</strong>
                    {selectedRuntime.pendingUiRequests.map((request) => {
                      const draft = answerDrafts[request.id] ?? request.prefill ?? "";
                      const options = Array.isArray(request.options) ? request.options : [];
                      return (
                        <div className="workspace-goals__dialog" key={request.id}>
                          <p>{request.title || request.message || "Answer this question to continue."}</p>
                          {request.message && request.title ? <p className="subtle">{request.message}</p> : null}
                          {request.method === "select" && options.length ? (
                            <select aria-label={request.title || "Choose an option"} value={draft} onChange={(event) => setAnswerDrafts((current) => ({...current, [request.id]: event.target.value}))}>
                              <option value="">Choose an option</option>
                              {options.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                          ) : request.method === "confirm" ? (
                            <select aria-label={request.title || "Confirm"} value={draft} onChange={(event) => setAnswerDrafts((current) => ({...current, [request.id]: event.target.value}))}>
                              <option value="">Choose an answer</option>
                              <option value="Yes">Yes</option>
                              <option value="No">No</option>
                            </select>
                          ) : (
                            <textarea aria-label={request.title || "Answer"} rows={4} placeholder={request.placeholder || "Type your answer"} value={draft} onChange={(event) => setAnswerDrafts((current) => ({...current, [request.id]: event.target.value}))} />
                          )}
                          <Button type="button" onClick={() => answerUiRequest(goal, request, draft)} disabled={!draft.trim() || answeringRequestId === request.id}>
                            {answeringRequestId === request.id ? "Sending..." : "Send answer"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                <div className="workspace-goal-card__actions">
                  {(goal.lifecycle === "draft" || goal.lifecycle === "ready" || goal.lifecycle === "interrupted" || goal.lifecycle === "paused") ? (
                    <>
                      <select aria-label="Pi session for goal" value={sessionIdForGoal(goal)} onChange={(event) => setSessionSelections((current) => ({...current, [goal.id]: event.target.value}))} disabled={Boolean(busyGoalId) || !compatibleSessions.length}>
                        <option value="">{compatibleSessions.length ? "Choose Pi session" : "No running Pi session"}</option>
                        {compatibleSessions.map((session) => <option key={session.id} value={session.id}>{session.name || session.id}</option>)}
                      </select>
                      <Button type="button" onClick={() => runAction(goal, goal.lifecycle === "draft" ? "start" : "resume", {sessionId: sessionIdForGoal(goal)})} disabled={Boolean(busyGoalId) || !compatibleSessions.some((session) => session.id === sessionIdForGoal(goal))}>{busyGoalId === goal.id ? "Working..." : goal.lifecycle === "draft" ? "Start" : "Resume"}</Button>
                    </>
                  ) : null}
                  {goal.lifecycle === "open" ? <Button variant="secondary" type="button" onClick={() => runAction(goal, "pause")} disabled={Boolean(busyGoalId)}>Pause</Button> : null}
                  {goal.lifecycle !== "archived" && goal.lifecycle !== "completed" ? <Button variant="danger" type="button" onClick={() => runAction(goal, "archive")} disabled={Boolean(busyGoalId)}>Archive</Button> : null}
                </div>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function friendlyGoalError(error) {
  const code = String(error?.message || error || "goal_request_failed");
  const messages = {
    goal_runner_unsupported: "Goals currently require a Pi runner.",
    goal_session_required: "Choose a running Pi session before starting the goal.",
    goal_bridge_unavailable: "This Pi runner does not have the Goals bridge. Restart it with the latest Pi image.",
    goal_structured_dialogs_unavailable: "This Pi runner can run lifecycle commands, but guided goal questions are not available yet.",
    goal_revision_conflict: "This goal changed in another tab. Refresh and try again.",
    goal_execution_busy: "Another goal is already running in this workspace.",
    goal_terminal_process_active: "Pi is open in Terminal/Chat. Switch this session to Goal control to continue.",
    goal_terminal_stop_timeout: "Pi did not stop in time. Finish its terminal work, then try again.",
    goal_command_failed: "Pi could not accept the goal command. Check the session model and authentication, then try again.",
    goal_command_timeout: "Pi did not respond in time. Refresh the goal status before retrying.",
    goal_command_in_progress: "Pi is still handling the previous goal command. Wait for it to finish.",
    goal_writer_conflict: "This session is read-only for workspace sync. Choose the workspace's writer session.",
    no_active_session: "The selected Pi session is not running.",
  };
  return messages[code] || code.replaceAll("_", " ");
}

function formatDate(value) {
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleString();
}

function runtimeStatusLabel(status) {
  return ({starting: "Starting Pi…", running: "Pi is working", waiting_for_input: "Waiting for your answer", ready: "Pi finished its turn", error: "Pi needs attention", interrupted: "Pi stopped", stopped: "Pi is stopped"})[status] || "Checking Pi status…";
}
