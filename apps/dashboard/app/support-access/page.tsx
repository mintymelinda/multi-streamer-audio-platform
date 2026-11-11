"use client";

import { useCallback, useEffect, useState } from "react";

type AuditEntry = {
  id: string;
  actor_user_id: string | null;
  action: string;
  reason: string;
  details: Record<string, unknown>;
  created_at: string;
};

type Grant = {
  id: string;
  support_twitch_user_id: string;
  reason: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  active: boolean;
};

const API = "/api";

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

export default function WorkspaceSupportAccessPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (id: string) => {
    setError("");
    try {
      const [access, events] = await Promise.all([
        request<Grant[]>(`/workspaces/${id}/support-access`),
        request<AuditEntry[]>(`/workspaces/${id}/support-access/audit`),
      ]);
      setGrants(access);
      setAudit(events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load support access history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("workspaceId") ?? "";
    setWorkspaceId(id);
    if (id) void load(id);
    else setLoading(false);
  }, [load]);

  async function revoke(grant: Grant) {
    if (!reason.trim()) {
      setError("Enter a reason before revoking support access.");
      return;
    }
    setBusyId(grant.id); setError(""); setMessage("");
    try {
      await request(`/workspaces/${workspaceId}/support-access/${grant.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      setReason("");
      setMessage("Support access revoked immediately.");
      await load(workspaceId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke support access.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span>♫</span> Streamer Audio</div><nav className="page-nav"><a href="/">Workspace dashboard</a></nav></header>
      <section className="welcome">
        <div><p className="eyebrow">WORKSPACE SECURITY</p><h1>Support access</h1><p className="subheading">Review every temporary platform support grant and revoke active access at any time.</p></div>
      </section>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      {!workspaceId && <section className="panel"><p>Open this page from your workspace dashboard to review its support access.</p></section>}
      {loading ? <div className="loading">Loading support access…</div> : workspaceId && (
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">ACCESS HISTORY</p><h2>Support sessions</h2></div></div>
          {grants.length === 0 ? <div className="quiet-empty"><p>No support access has been granted to this workspace.</p></div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Support account</th><th>Reason</th><th>Scopes</th><th>Expires</th><th>Status</th><th /></tr></thead>
                <tbody>{grants.map((grant) => (
                  <tr key={grant.id}>
                    <td>{grant.support_twitch_user_id}</td>
                    <td>{grant.reason}</td>
                    <td>{grant.scopes.join(", ")}</td>
                    <td>{new Date(grant.expires_at).toLocaleString()}</td>
                    <td>{grant.active ? <strong>Active</strong> : grant.revoked_at ? "Revoked" : "Expired"}</td>
                    <td>{grant.active && <button className="text-button" disabled={Boolean(busyId) || !reason.trim()} onClick={() => void revoke(grant)}>{busyId === grant.id ? "Revoking…" : "Revoke"}</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {grants.some((grant) => grant.active) && (
            <div className="settings-form">
              <label>Reason for revoking support access<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} required /></label>
              <p className="panel-note">Choose Revoke on the specific active grant. Revocation takes effect immediately.</p>
            </div>
          )}
        </section>
      )}
      {workspaceId && !loading && (
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Support access activity</h2></div></div>
          {audit.length === 0 ? <div className="quiet-empty"><p>No support access activity has been recorded.</p></div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>When</th><th>Action</th><th>Actor account ID</th><th>Reason</th></tr></thead>
                <tbody>{audit.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.created_at).toLocaleString()}</td>
                    <td>{entry.action.replaceAll("_", " ")}</td>
                    <td>{entry.actor_user_id ?? "System"}</td>
                    <td>{entry.reason}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
