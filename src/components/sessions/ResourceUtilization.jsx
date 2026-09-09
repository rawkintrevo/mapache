import "./ResourceUtilization.css";

export function ResourceUtilization({sample = null, connectionState = "idle"}) {
  const unavailable = connectionState === "unavailable";
  return (
    <div aria-label="Resource utilization" className={`resource-utilization resource-utilization--${connectionState}`}>
      <ResourceMeter
        label="CPU"
        percent={sample?.cpu?.percent}
        value={sample ? `${formatPercent(sample.cpu.percent)}%` : unavailable ? "Unavailable" : "—"}
        detail={sample ? `${formatPercent(sample.cpu.percent)} percent of ${formatCores(sample.cpu.limitCores)} available CPU` : "CPU utilization unavailable"}
      />
      <ResourceMeter
        label="RAM"
        percent={sample?.memory?.percent}
        value={sample ? `${formatBytes(sample.memory.usedBytes)}/${formatBytes(sample.memory.limitBytes)}` : unavailable ? "Unavailable" : "—"}
        detail={sample ? `${formatBytes(sample.memory.usedBytes)} of ${formatBytes(sample.memory.limitBytes)}, ${formatPercent(sample.memory.percent)} percent utilized` : "RAM utilization unavailable"}
      />
    </div>
  );
}

function ResourceMeter({label, percent, value, detail}) {
  const known = Number.isFinite(percent);
  const normalizedPercent = known ? Math.min(100, Math.max(0, percent)) : 0;
  const tone = known ? getUtilizationTone(normalizedPercent) : "unknown";
  return (
    <div className={`resource-meter resource-meter--${tone}`} title={detail}>
      <div className="resource-meter__label-row">
        <span className="resource-meter__label">{label}</span>
        <span className="resource-meter__value">{value}</span>
      </div>
      <div
        aria-label={`${label} utilization`}
        aria-valuemax="100"
        aria-valuemin="0"
        aria-valuenow={known ? normalizedPercent : undefined}
        aria-valuetext={detail}
        className="resource-meter__track"
        role="meter"
      >
        <span className="resource-meter__fill" style={{width: `${normalizedPercent}%`}} />
      </div>
    </div>
  );
}

export function getUtilizationTone(percent) {
  if (!Number.isFinite(percent)) return "unknown";
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warning";
  return "healthy";
}

function formatPercent(value) {
  return String(Math.round(Number(value)));
}

function formatCores(value) {
  return `${Number(value).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} vCPU`;
}

function formatBytes(value) {
  const gib = Number(value) / (1024 ** 3);
  if (!Number.isFinite(gib) || gib < 0) return "—";
  return `${gib.toFixed(1).replace(/\.0$/, "")} GiB`;
}
