import {useState} from "react";
import {
  formatEstimatedHourlyPrice,
  formatSessionMemory,
  formatSessionSizeLabel,
  inferSessionSize,
  isValidSessionResourcePair,
  sessionCpuOptions,
  sessionMemoryOptions,
  sessionSizePresets,
} from "../../utils/sessionResources.js";
import "./SessionResourceSelector.css";

export function SessionResourceSelector({
  cpu,
  memory,
  cpuName = "cpu",
  memoryName = "memory",
  onChange,
  sizeName = "sessionSize",
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selectedSize = inferSessionSize(cpu, memory);
  const customPrice = formatEstimatedHourlyPrice(cpu, memory);

  return (
    <fieldset className="session-resource-selector">
      <legend>Session size</legend>
      <div className="session-size-options" role="radiogroup" aria-label="Session size presets">
        {sessionSizePresets.map((preset) => (
          <label className={`session-size-card ${selectedSize === preset.key ? "selected" : ""}`} key={preset.key}>
            <input
              aria-label={`${preset.label}: ${preset.cpu} vCPU / ${formatSessionMemory(preset.memory)}, ${formatEstimatedHourlyPrice(preset.cpu, preset.memory)}`}
              checked={selectedSize === preset.key}
              name={sizeName}
              type="radio"
              value={preset.key}
              onChange={() => onChange({cpu: preset.cpu, memory: preset.memory})}
            />
            <span className="session-size-card__body">
              <strong>{preset.label}</strong>
              <span>{preset.cpu} vCPU / {formatSessionMemory(preset.memory)}</span>
              <small>{formatEstimatedHourlyPrice(preset.cpu, preset.memory)}</small>
            </span>
          </label>
        ))}
        <label className={`session-size-card session-size-card--custom ${selectedSize === "custom" ? "selected" : ""}`}>
          <input
            aria-label={`Custom: ${cpu || "unknown"} vCPU / ${formatSessionMemory(memory)}`}
            checked={selectedSize === "custom"}
            disabled
            name={sizeName}
            type="radio"
            value="custom"
            readOnly
          />
          <span className="session-size-card__body">
            <strong>Custom</strong>
            <span>{cpu || "—"} vCPU / {formatSessionMemory(memory) || "—"}</span>
            <small>{customPrice}</small>
          </span>
        </label>
      </div>
      <p className="session-resource-estimate" aria-live="polite">
        {formatSessionSizeLabel(selectedSize)} selection: {customPrice}. Compute-only estimate before free tier and discounts; excludes network, storage, build, and other charges. <a href="https://cloud.google.com/run/pricing" rel="noreferrer" target="_blank">Pricing details</a>
      </p>
      <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>Advanced settings</summary>
        <div className="session-resource-advanced">
          <SessionResourceFields cpu={cpu} cpuName={cpuName} memory={memory} memoryName={memoryName} onChange={onChange} />
          <p className="subtle">Cloud Run does not support every CPU and memory combination.</p>
        </div>
      </details>
    </fieldset>
  );
}

export function SessionResourceFields({cpu, memory, cpuName = "cpu", memoryName = "memory", onChange}) {
  const currentCpu = String(cpu || "");
  const currentMemory = String(memory || "");
  const cpuOptions = includeCurrentOption(sessionCpuOptions, currentCpu);
  const memoryOptions = includeCurrentOption(sessionMemoryOptions, currentMemory);

  return (
    <div className="session-resource-fields">
      <label>
        <span>CPU</span>
        <select
          name={cpuName}
          value={currentCpu}
          onChange={(event) => {
            const nextCpu = event.target.value;
            if (isValidSessionResourcePair(nextCpu, currentMemory)) onChange({cpu: nextCpu, memory: currentMemory});
          }}
        >
          {cpuOptions.map((value) => (
            <option disabled={value !== currentCpu && !isValidSessionResourcePair(value, currentMemory)} key={value} value={value}>
              {value} vCPU{value === currentCpu && !isValidSessionResourcePair(value, currentMemory) ? " (unsupported pair)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Memory</span>
        <select
          name={memoryName}
          value={currentMemory}
          onChange={(event) => {
            const nextMemory = event.target.value;
            if (isValidSessionResourcePair(currentCpu, nextMemory)) onChange({cpu: currentCpu, memory: nextMemory});
          }}
        >
          {memoryOptions.map((value) => (
            <option disabled={value !== currentMemory && !isValidSessionResourcePair(currentCpu, value)} key={value} value={value}>
              {formatSessionMemory(value)}{value === currentMemory && !isValidSessionResourcePair(currentCpu, value) ? " (unsupported pair)" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function includeCurrentOption(options, current) {
  return current && !options.includes(current) ? [current, ...options] : options;
}
