export function FatalError({error}) {
  return (
    <div className="auth">
      <section className="auth-panel">
        <h1>Configuration error</h1>
        <p>{error?.message || "The app could not start."}</p>
      </section>
    </div>
  );
}
