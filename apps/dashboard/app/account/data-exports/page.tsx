"use client";

import { useCallback, useEffect, useState } from "react";

type ExportRecord = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "expired";
  requested_at: string;
  completed_at: string | null;
  expires_at: string | null;
  downloaded_at: string | null;
  failure_code: string | null;
};
const API = "/api";
function csrf() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrf());
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in to manage account exports." : `Request failed (${response.status}).`);
  return response.json() as Promise<T>;
}
function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}
export default function AccountDataExportsPage() {
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setExports(await request<ExportRecord[]>("/me/exports")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load account exports."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!exports.some((item) => item.status === "queued" || item.status === "processing")) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [exports, load]);
  async function createExport() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await request<{ export: ExportRecord; reused: boolean }>("/me/exports", { method: "POST" });
      setMessage(result.reused ? "Your existing export is still being prepared." : "Your export request has been queued.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not request an export."); }
    finally { setBusy(false); }
  }
  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team</a><a href="/notifications">Notifications</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">YOUR ACCOUNT</p><h1>Account data exports</h1><p className="subheading">Download a copy of the personal account information held by the platform.</p></div></section>
    {error && <div className="error-banner">{error}</div>}
    {message && <p role="status">{message}</p>}
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">PERSONAL DATA</p><h2>Request an export</h2></div></div>
      <p className="subheading">Exports include your account details, your workspace memberships, invitations addressed to you, your notification history, and your notification preferences. Workspace-owned content and settings are handled separately.</p>
      <p className="subheading">Exports are generated in the background. Completed downloads are available for seven days and require you to be signed in to this account. You can request one export every 24 hours.</p>
      <button className="secondary-button" disabled={busy || exports.some((item) => item.status === "queued" || item.status === "processing")} onClick={() => void createExport()}>Request account export</button>
    </section>
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">EXPORT HISTORY</p><h2>Your exports</h2></div><button className="secondary-button" disabled={busy} onClick={() => void load()}>Refresh</button></div>
      {exports.length ? <div className="notification-list">{exports.map((item) => <article className="notification-row" key={item.id}>
        <div className="notification-content"><strong>Account data export</strong><p>Status: {item.status}</p><small>Requested {date(item.requested_at)}</small>
          {item.completed_at && <small>Completed {date(item.completed_at)}</small>}
          {item.expires_at && item.status === "completed" && <small>Download expires {date(item.expires_at)}</small>}
          {item.failure_code && <small>The export could not be generated. You can try again after the request limit resets.</small>}
          {item.status === "completed" && <a href={`${API}/me/exports/${item.id}/download`} rel="noreferrer">Download JSON export</a>}
          {item.downloaded_at && <small>Last downloaded {date(item.downloaded_at)}</small>}
        </div>
      </article>)}</div> : <div className="quiet-empty"><span>♫</span><p>No account exports yet.</p><small>Request an export to create a downloadable copy of your personal account data.</small></div>}
    </section>
    <footer className="footer"><span>Personal account data</span><a href="/">Back to dashboard</a></footer>
  </main>;
}
