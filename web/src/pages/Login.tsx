// Sign-on goes through Medhanta core (D-29): the button sends the browser to core's sign-in page.
export function Login() {
  return (
    <main className="page narrow login">
      <img className="login-logo" src="/medhanta-logo.png" alt="Medhanta: Where Expertise Meets Intelligence" />
      <h1>Pharma Logbook</h1>
      <p className="muted">Electronic GMP logbooks for equipment, rooms and breakdowns. Sign in with your own Medhanta login.</p>
      <div className="card">
        <a className="button primary" href="/login">Sign in</a>
      </div>
    </main>
  );
}
