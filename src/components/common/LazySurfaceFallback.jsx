import "./LazySurfaceFallback.css";

export function LazySurfaceFallback({label = "Loading..."}) {
  return <div aria-live="polite" className="lazy-surface-fallback" role="status">{label}</div>;
}
