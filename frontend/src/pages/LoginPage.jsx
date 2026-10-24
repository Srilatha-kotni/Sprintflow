import { useState } from "react";
import { api } from "../api";
import { Spinner } from "../components/ui";

export default function LoginPage({ onLogin, notify, theme, toggleTheme }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const registering = mode === "register";

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (registering && password.length < 6) { setError("Use at least 6 characters for your password."); return; }
    setLoading(true);
    try {
      const data = await api(registering ? "/auth/register" : "/auth/login", { method: "POST", body: { email: email.trim(), password } });
      notify("success", registering ? "Account created. Welcome!" : "Welcome back!");
      onLogin({ token: data.token, email: data.email, isAdmin: !!data.is_admin });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <button className="icon-btn login-theme" onClick={toggleTheme} aria-label="Toggle dark mode">{theme === "dark" ? "☀" : "☾"}</button>
      <div className="login-card">
        <div className="login-brand">SprintFlow</div>
        <p className="login-tagline">The sprint board that updates itself from your standups.</p>

        <div className="segmented login-switch" role="tablist">
          <button type="button" role="tab" aria-selected={!registering} className={`segment ${!registering ? "segment-active" : ""}`} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
          <button type="button" role="tab" aria-selected={registering} className={`segment ${registering ? "segment-active" : ""}`} onClick={() => { setMode("register"); setError(""); }}>Create account</button>
        </div>

        <form className="form" onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoFocus />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" autoComplete={registering ? "new-password" : "current-password"} value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder={registering ? "At least 6 characters" : "Your password"} required />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={loading}>
            {loading ? <><Spinner small /> {registering ? "Creating account…" : "Signing in…"}</> : registering ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
