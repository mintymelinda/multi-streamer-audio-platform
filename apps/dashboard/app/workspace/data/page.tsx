"use client";

import { useEffect, useState } from "react";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "moderator" | "viewer"; status: string };
const API = "/api";
function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}
export default function WorkspaceDataPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function load() {
    setError("");
    try {
      const response = await fetch(`${API}/workspaces`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in to manage workspace data." : `Could not load workspaces (${response.status}).`);
      setWorkspaces(await response.json() as Workspace[]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load workspaces."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function exportWorkspace(workspace: Workspace) {
    setBusy(workspace.id); setError(""); setMessage("");
    try {
      const response = await fetch(`${API}/workspaces/${workspace.id}/export`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(`Workspace export failed (${response.status}). Only the workspace owner can export it.`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${workspace.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}-workspace-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`Workspace export downloaded for ${workspace.name}. Asset links in the export expire after seven days.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export workspace."); }
    finally { setBusy(""); }
  }
  async function deleteWorkspace(workspace: Workspace) {
    setBusy(workspace.id); setError(""); setMessage("");
    try {
      const response = await fetch(`${API}/workspaces/${workspace.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken() },
        body: JSON.stringify({ confirmationName: confirmations[workspace.id] ?? "" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? `Workspace deletion failed (${response.status}).`);
      }
      setMessage(`Workspace ${workspace.name} was permanently deleted. Your platform account remains active.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete workspace."); }
    finally { setBusy(""); }
  }
  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team</a><a href="/settings">Settings</a><a href="/account/data-exports">Account data</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">WORKSPACE DATA</p><h1>Export or delete a workspace</h1><p className="subheading">Workspace exports and permanent deletion are available to each workspace owner.</p></div></section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    {loading ? <section className="panel">Loading workspaces…</section> : workspaces.length ? workspaces.map((workspace) => <section className="panel settings-panel" key={workspace.id}>
      <div className="panel-heading"><div><p className="eyebrow">{workspace.role.toUpperCase()} · {workspace.status.toUpperCase()}</p><h2>{workspace.name}</h2></div></div>
      {workspace.role === "owner" ? <>
        <p className="subheading">Download workspace configuration and tenant-owned records. Asset files are provided as seven-day download links. Credential material and bearer-token hashes are never exported.</p>
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void exportWorkspace(workspace)}>{busy === workspace.id ? "Working…" : "Download workspace export"}</button>
        <div className="danger-zone">
          <h3>Permanent deletion</h3>
          <p className="subheading">This permanently removes the workspace, scenes and OBS URLs, integrations and stored credentials, requests, queue data, invitations, memberships, settings, and uploaded asset files. Your platform account and memberships in other workspaces remain.</p>
          <label htmlFor={`confirm-${workspace.id}`}>Type <strong>{workspace.name}</strong> to confirm</label>
          <input id={`confirm-${workspace.id}`} value={confirmations[workspace.id] ?? ""} onChange={(event) => setConfirmations((current) => ({ ...current, [workspace.id]: event.target.value }))} autoComplete="off" />
          <button type="button" className="danger-button" disabled={Boolean(busy) || confirmations[workspace.id] !== workspace.name} onClick={() => void deleteWorkspace(workspace)}>Permanently delete workspace</button>
        </div>
      </> : <p className="subheading">Only the workspace owner can export or permanently delete this workspace.</p>}
    </section>) : <section className="panel"><p>You do not currently belong to a workspace.</p></section>}
    <footer className="footer"><span>Workspace data controls</span><a href="/">Back to dashboard</a></footer>
  </main>;
}
