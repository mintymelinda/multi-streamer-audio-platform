"use client";

import { useState } from "react";

const API = "/api";
const SCOPES = [
  ["workspace.read", "Workspace details"],
  ["requests.read", "Recent request content"],
  ["providers.read", "Provider configuration and health"],
] as const;

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new Error(typeof payload?.message === "string" ? payload.message : `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export default function SupportOperationsPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [reason, setReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [scopes, setScopes] = useState<string[]>(["requests.read"]);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [grant, setGrant] = useState<{ id: string; expires_at: string; scopes: string[] } | null>(null);
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function toggleScope(scope: string) {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  }

  async function loadDiagnostics(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setDiagnostics(null);
    try {
      setDiagnostics(await request(`/platform-admin/diagnostics/workspaces/${workspaceId.trim()}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load technical diagnostics.");
    } finally {
      setBusy(false);
    }
  }

  async function startSupportAccess(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setGrant(null); setContent(null);
    try {
      const created = await request<{ id: string; expires_at: string; scopes: string[] }>("/platform-admin/support-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspaceId.trim(), reason, durationMinutes, scopes }),
      });
      setGrant(created);
      setContent(await request<Record<string, unknown>>(`/platform-admin/support-access/${created.id}/content`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start support access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>♫</span> Streamer Audio</div>
        <nav className="page-nav"><a href="/platform-admin">Platform administration</a><a href="/">Workspace dashboard</a></nav>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Diagnostics & support</h1><p className="subheading">Technical diagnostics are content-free. Workspace content requires a separate, temporary, read-only support grant.</p></div>
      </section>
      {error && <div className="error-banner">{error}</div>}
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">TECHNICAL DIAGNOSTICS</p><h2>Inspect workspace health</h2></div></div>
        <form className="settings-form" onSubmit={loadDiagnostics}>
          <label>Workspace ID<input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="Workspace UUID" required /></label>
          <button className="secondary-button" type="submit" disabled={busy}>{busy ? "Loading…" : "Load technical diagnostics"}</button>
        </form>
        {diagnostics && <pre className="diagnostic-output">{JSON.stringify(diagnostics, null, 2)}</pre>}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">TEMPORARY SUPPORT ACCESS</p><h2>Open a scoped support session</h2></div></div>
        <p className="panel-note">Every grant requires a reason, expires automatically after 5–240 minutes, and can be revoked immediately by the workspace owner. Only read scopes are available.</p>
        <form className="settings-form" onSubmit={startSupportAccess}>
          <label>Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} required /></label>
          <label>Duration<select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option><option value={240}>4 hours</option></select></label>
          <fieldset><legend>Read-only scopes</legend>{SCOPES.map(([scope, label]) => <label className="checkbox-row" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />{label}</label>)}</fieldset>
          <button className="primary-button" type="submit" disabled={busy || !workspaceId.trim() || !reason.trim() || scopes.length === 0}>{busy ? "Opening…" : "Grant temporary access"}</button>
        </form>
        {grant && <div className="quiet-empty"><strong>Support access is active</strong><p>Expires {new Date(grant.expires_at).toLocaleString()}</p><small>Scopes: {grant.scopes.join(", ")}</small></div>}
        {content && <><h3>Authorized workspace content</h3><pre className="diagnostic-output">{JSON.stringify(content, null, 2)}</pre></>}
      </section>
    </main>
  );
}
