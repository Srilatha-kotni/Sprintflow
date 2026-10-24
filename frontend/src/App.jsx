import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { useConfirm, useToasts } from "./hooks";
import { ConfirmDialog, Toasts } from "./components/ui";
import LoginPage from "./pages/LoginPage";
import AdminPage from "./pages/AdminPage";
import WorkspacesPage from "./pages/WorkspacesPage";
import WorkspacePage from "./pages/WorkspacePage";

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

export default function App() {
  const [session, setSession] = useState(() => readJSON("session"));
  const [workspace, setWorkspace] = useState(() => readJSON("workspace"));
  const [theme, setTheme] = useState(() => readJSON("theme") || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const { toasts, notify, dismiss } = useToasts();
  const { confirm, request, close } = useConfirm();

  useEffect(() => {
    document.body.classList.toggle("dark", theme === "dark");
    store("theme", theme);
  }, [theme]);

  useEffect(() => { store("session", session); }, [session]);
  useEffect(() => { store("workspace", workspace); }, [workspace]);

  const logout = useCallback(() => {
    setSession(null);
    setWorkspace(null);
  }, []);

  // api() fires this when the server says the login has expired
  useEffect(() => {
    const onExpired = () => {
      notify("error", "Your session expired. Please sign in again.");
      logout();
    };
    window.addEventListener("sprintflow:logout", onExpired);
    return () => window.removeEventListener("sprintflow:logout", onExpired);
  }, [logout, notify]);

  const chrome = { theme, toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")), onLogout: logout };

  let page;
  if (!session) {
    page = <LoginPage onLogin={setSession} notify={notify} theme={theme} toggleTheme={chrome.toggleTheme} />;
  } else if (session.isAdmin) {
    page = <AdminPage session={session} notify={notify} confirm={confirm} chrome={chrome} />;
  } else if (!workspace) {
    page = <WorkspacesPage session={session} onOpen={setWorkspace} notify={notify} chrome={chrome} />;
  } else {
    page = <WorkspacePage key={workspace.id} session={session} workspace={workspace} onBack={() => setWorkspace(null)} notify={notify} confirm={confirm} chrome={chrome} />;
  }

  return (
    <>
      {page}
      <Toasts toasts={toasts} dismiss={dismiss} />
      <ConfirmDialog request={request} close={close} />
    </>
  );
}
