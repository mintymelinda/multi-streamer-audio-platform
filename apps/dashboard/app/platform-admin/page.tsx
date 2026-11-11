"use client";

import { useCallback, useEffect, useState } from "react";

type Access = { isPlatformAdministrator: boolean; role: "owner" | "admin" | null; permissions: string[] };
type Assignment = {
  user_id: string;
  twitch_user_id: string;
  role: "owner" | "admin";
  permissions: string[];
  appointed_at: string;
  revoked_at: string | null;
};

const API = "/api";
const PERMISSIONS = [
  ["accounts.read", "View accounts"],
  ["accounts.suspend", "Suspend accounts"],
  ["workspaces.read", "View workspaces"],
  ["workspaces.restrict", "Restrict workspaces"],
  ["settings.read", "View platform settings"],
  ["settings.write", "Change platform settings"],
  ["support_access.manage", "Manage temporary support access"],
  ["administrators.read", "View administrators"],
  ["administrators.manage", "Manage administrators"],
  ["rights_reports.manage", "Manage rights-holder reports"],
  ["status.manage", "Manage public service incidents"],
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
    const message = typeof payload?.message === "string" ? payload.message : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function PlatformAdministrationPage() {
  const [access, setAccess] = useState<Access | null>(null);
  const [administrators, setAdministrators] = useState<Assignment[]>([]);
  const [twitchUserId, setTwitchUserId] = useState("");
  const [role, setRole] = useState<"admin" | "owner">("admin");
  const [permissions, setPermissions] = useState<string[]>(["administrators.read"]);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const current = await request<Access>("/platform-admin/me");
      setAccess(current);
      if (current.role === "admin") setPermissions(current.permissions);
      if (current.isPlatformAdministrator && (current.permissions.includes("administrators.read") || current.permissions.includes("administrators.manage"))) {
        setAdministrators(await request<Assignment[]>("/platform-admin/administrators"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load platform administration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function togglePermission(permission: string) {
    setPermissions((current) => current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission]);
  }

  async function appoint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request("/platform-admin/administrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ twitchUserId: twitchUserId.trim(), role, permissions, reason }),
      });
      setTwitchUserId("");
      setReason("");
      setMessage("Platform administrator assignment saved.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save administrator assignment.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(assignment: Assignment) {
    if (!window.confirm(`Revoke platform administrator access for Twitch account ${assignment.twitch_user_id}?`)) return;
    const actionReason = window.prompt("Reason for revoking access");
    if (!actionReason?.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(`/platform-admin/administrators/${assignment.user_id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: actionReason }),
      });
      setMessage("Platform administrator access revoked.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke administrator access.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="shell"><div className="loading">Loading platform administration…</div></main>;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>♫</span> Streamer Audio</div>
        <nav className="page-nav"><a href="/platform-admin/maintenance">Planned maintenance</a><a href="/platform-admin/incidents">Service incidents</a><a href="/status">Public status</a><a href="/platform-admin/restrictions">Account & workspace controls</a><a href="/platform-admin/support">Diagnostics & support</a><a href="/">Workspace dashboard</a></nav>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Administration</h1><p className="subheading">Manage platform-level access independently of workspace roles.</p></div>
        {access?.role && <span className="status status--good">{access.role}</span>}
      </section>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      {!access?.isPlatformAdministrator ? (
        <section className="panel"><h2>Access restricted</h2><p>This account has not been appointed as a platform administrator. Workspace ownership does not grant platform-level access.</p></section>
      ) : (
        <>
          {access.permissions.includes("administrators.read") && (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h2>Platform administrators</h2></div></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Twitch user ID</th><th>Role</th><th>Permissions</th><th>Status</th><th /></tr></thead>
                  <tbody>{administrators.map((item) => (
                    <tr key={item.user_id}>
                      <td>{item.twitch_user_id}</td>
                      <td>{item.role}</td>
                      <td>{item.role === "owner" ? "All platform permissions" : item.permissions.join(", ") || "None"}</td>
                      <td>{item.revoked_at ? "Revoked" : "Active"}</td>
                      <td>{!item.revoked_at && access.permissions.includes("administrators.manage") && <button className="text-button" disabled={busy || (item.role === "owner" && access.role !== "owner")} onClick={() => void revoke(item)}>Revoke</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          )}
          {access.permissions.includes("administrators.manage") && (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">APPOINTMENT</p><h2>Appoint an administrator</h2></div></div>
              <form onSubmit={appoint} className="settings-form">
                <label>Twitch numeric user ID<input value={twitchUserId} onChange={(event) => setTwitchUserId(event.target.value)} inputMode="numeric" pattern="[0-9]{1,32}" placeholder="Stable numeric Twitch ID" required /></label>
                <label>Role<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "owner")} disabled={access.role !== "owner"}><option value="admin">Administrator</option>{access.role === "owner" && <option value="owner">Platform owner</option>}</select></label>
                <fieldset><legend>Function-scoped permissions</legend>{PERMISSIONS.map(([key, label]) => (
                  <label className="checkbox-row" key={key}><input type="checkbox" checked={permissions.includes(key)} onChange={() => togglePermission(key)} disabled={access.role !== "owner" && !access.permissions.includes(key)} />{label}</label>
                ))}</fieldset>
                <label>Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} required /></label>
                <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save appointment"}</button>
              </form>
            </section>
          )}
        </>
      )}
    </main>
  );
}
