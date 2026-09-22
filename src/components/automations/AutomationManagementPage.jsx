import {AutomationsPanel} from "./AutomationsPanel.jsx";
import {RunHistoryPage} from "./RunHistoryPage.jsx";
import "./AutomationManagementPage.css";

export function AutomationManagementPage({state, ...props}) {
  return (
    <div className="automation-management-page">
      <header className="automation-management-page__header">
        <div>
          <p className="eyebrow">Automation operations</p>
          <h2>Automations</h2>
          <p className="subtle">Manage scheduled definitions and inspect every run from one screen.</p>
        </div>
      </header>
      <AutomationsPanel
        onCreateDefinition={props.onCreateDefinition}
        onDeleteDefinition={props.onDeleteDefinition}
        onLoadHistory={props.onLoadHistory}
        onLoadWorkspace={props.onLoadWorkspace}
        onOpenHistory={props.onOpenHistory}
        onPrepareStorage={props.onPrepareStorage}
        onPreviewSchedule={props.onPreviewSchedule}
        onRunNow={props.onRunNow}
        onShowWorkspace={props.onShowWorkspace}
        onUpdateDefinition={props.onUpdateDefinition}
        onUpdateSettings={props.onUpdateSettings}
        state={state}
      />
      <RunHistoryPage
        embedded
        onLoadEvents={props.onLoadEvents}
        onLoadHistory={props.onLoadGlobalHistory}
        onLoadNextPage={props.onLoadNextGlobalHistoryPage}
        onRestartRun={props.onRestartRun}
        onSelectRun={props.onSelectRun}
        onSetFilters={props.onSetGlobalHistoryFilters}
        onStopRun={props.onStopGlobalRun}
        state={state}
      />
    </div>
  );
}
