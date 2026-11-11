"use client";

import { useCallback, useEffect, useState } from "react";

type Access = {
  isPlatformAdministrator: boolean;
  role: "owner" | "admin" | null;
  permissions: string[];
};
type Account = {
  user_id: string;
  twitch_user_id: string;
  status: "active" | "suspended";
  created_at: string;
  suspended_at: string | null;
  suspension_reason: string | null;
};
type Workspace = {
  workspace_id: string;
  name: string;
  owner_user_id: string;
  owner_twitch_user_id: string;
  broadcaster_twitch_user_id: string;
  status: "active" | "restricted" | "suspended";
  restriction_reason: string | null;
  created_at: string;
  updated_at: string;
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
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export default function PlatformRestrictionsPage() {
  const [access, setAccess] = useState<Access | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [accountSearch, setAccountSearch] = useState("");
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadAccounts = useCallback(async (search = accountSearch) => {
    if (!access?.permissions.includes("accounts.read")) return;
    const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
    setAccounts(await request<Account[]>(`/platform-admin/accounts${query}`));
  }, [access, accountSearch]);

  const loadWorkspaces = useCallback(async (search = workspaceSearch) => {
    if (!access?.permissions.includes("workspaces.read")) return;
    const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
    setWorkspaces(await request<Workspace[]>(`/platform-admin/workspaces${query}`));
  }, [access, workspaceSearch]);

  const load = useCallback(async () => {
    setError("");
    try {
      const current = await request<Access>("/platform-admin/me");
      setAccess(current);
      if (current.permissions.includes("accounts.read")) {
        setAccounts(await request<Account[]>("/platform-admin/accounts"));
      }
      if (current.permissions.includes("workspaces.read")) {
        setWorkspaces(await request<Workspace[]>("/platform-admin/workspaces"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load restriction controls.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function changeStatus(kind: "account" | "workspace", id: string, status: string, label: string) {
    if (!window.confirm(`${label} this ${kind}? This does not delete the account, workspace, or its data.`)) return;
    const reason = window.prompt(`Reason for this ${kind} status change`);
    if (!reason?.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const path = kind === "account"
        ? `/platform-admin/accounts/${id}/status`
        : `/platform-admin/workspaces/${id}/status`;
      await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason }),
      });
      setMessage(`${kind === "account" ? "Account" : "Workspace"} status updated and audited.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not update ${kind} status.`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="shell"><div className="loading">Loading platform restrictions…</div></main>;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>♫</span> Streamer Audio</div>
        <nav className="page-nav"><a href="/platform-admin">Administration</a><a href="/platform-admin/support">Diagnostics & support</a><a href="/">Workspace dashboard</a></nav>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Account & workspace controls</h1><p className="subheading">Apply temporary or ongoing access restrictions with a required reason and an immutable audit record. These controls never delete data.</p></div>
        {access?.role && <span className="status status--good">{access.role}</span>}
      </section>
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      {!access?.isPlatformAdministrator ? (
        <section className="panel"><h2>Access restricted</h2><p>This account has not been appointed as a platform administrator.</p></section>
      ) : (
        <>
          {access.permissions.includes("accounts.read") && (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">ACCOUNT MODERATION</p><h2>Platform accounts</h2></div></div>
              <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void loadAccounts(); }}>
                <label>Search by Twitch numeric ID or account ID<input value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} maxLength={120} /></label>
                <button className="secondary-button" type="submit" disabled={busy}>Search accounts</button>
              </form>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Twitch user ID</th><th>Status</th><th>Reason</th><th>Updated</th><th>Action</th></tr></thead>
                  <tbody>{accounts.map((account) => (
                    <tr key={account.user_id}>
                      <td>{account.twitch_user_id}</td>
                      <td>{account.status}</td>
                      <td>{account.suspension_reason ?? "—"}</td>
                      <td>{account.suspended_at ? new Date(account.suspended_at).toLocaleString() : "—"}</td>
                      <td>{access.permissions.includes("accounts.suspend") && (
                        <button className="text-button" disabled={busy} onClick={() => void changeStatus("account", account.user_id, account.status === "active" ? "suspended" : "active", account.status === "active" ? "Suspend" : "Reinstate")}>
                          {account.status === "active" ? "Suspend" : "Reinstate"}
                        </button>
                      )}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {accounts.length === 0 && <p className="quiet-empty">No matching accounts.</p>}
              </div>
            </section>
          )}
          {access.permissions.includes("workspaces.read") && (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">WORKSPACE MODERATION</p><h2>Workspaces</h2></div></div>
              <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void loadWorkspaces(); }}>
                <label>Search by workspace name, workspace ID, or Twitch ID<input value={workspaceSearch} onChange={(event) => setWorkspaceSearch(event.target.value)} maxLength={120} /></label>
                <button className="secondary-button" type="submit" disabled={busy}>Search workspaces</button>
              </form>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Workspace</th><th>Owner Twitch ID</th><th>Status</th><th>Reason</th><th>Actions</th></tr></thead>
                  <tbody>{workspaces.map((workspace) => (
                    <tr key={workspace.workspace_id}>
                      <td>{workspace.name}<small>{workspace.workspace_id}</small></td>
                      <td>{workspace.owner_twitch_user_id}</td>
                      <td>{workspace.status}</td>
                      <td>{workspace.restriction_reason ?? "—"}</td>
                      <td>{access.permissions.includes("workspaces.restrict") && (
                        <div className="action-group">
                          {workspace.status === "active" && <button className="text-button" disabled={busy} onClick={() => void changeStatus("workspace", workspace.workspace_id, "restricted", "Restrict")}>Restrict</button>}
                          {workspace.status !== "suspended" && <button className="text-button" disabled={busy} onClick={() => void changeStatus("workspace", workspace.workspace_id, "suspended", "Suspend")}>Suspend</button>}
                          {workspace.status !== "active" && <button className="text-button" disabled={busy} onClick={() => void changeStatus("workspace", workspace.workspace_id, "active", "Restore")}>Restore</button>}
                        </div>
                      )}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {workspaces.length === 0 && <p className="quiet-empty">No matching workspaces.</p>}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
