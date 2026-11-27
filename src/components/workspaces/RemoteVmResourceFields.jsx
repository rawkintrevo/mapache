export const DEFAULT_REMOTE_RESOURCES = {cpu: "2", memory: "8Gi"};

export function RemoteVmResourceFields({resources, onChange}) {
  return <>
    <label>
      <span>Virtual CPUs</span>
      <input type="number" min="1" max="64" required value={resources.cpu}
        onChange={(event) => onChange({...resources, cpu: event.target.value})} />
    </label>
    <label>
      <span>Memory (GiB)</span>
      <input type="number" min="1" max="256" required value={resources.memory.replace(/Gi$/, "")}
        onChange={(event) => onChange({...resources, memory: event.target.value + "Gi"})} />
    </label>
  </>;
}
