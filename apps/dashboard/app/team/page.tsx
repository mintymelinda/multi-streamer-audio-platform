"use client";

import { useEffect, useState } from "react";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "moderator" | "viewer" };
type Member = { user_id: string; twitch_user_id: string; role: string; status: string; created_at: string };
type Invitation = { id: string; invited_twitch_user_id: string; assigned_role: string; created_at: string; expires_at: string };
type AuditEvent = { id: string; event_type: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; created_at: string; actor_twitch_user_id: string | null };

const API = "/api";
function csrf() { return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? ""; }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrf());
  const response = await fetch(`${API}${path}`, { ...init, credentials: "include", cache: "no-store", headers });
  if (!response.ok) throw new Error(response.status === 403 ? "You do not have permission to manage this workspace." : `Request failed (${response.status}).`);
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

export default function TeamPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("moderator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = workspaces.find((workspace) => workspace.id === workspaceId);

  async function load(id = workspaceId) {
    if (!id) return;
    setError("");
    try {
      const [nextMembers, nextInvites, nextAudit] = await Promise.all([
        request<Member[]>(`/workspaces/${id}/members`),
        request<Invitation[]>(`/workspaces/${id}/invitations`),
        request<AuditEvent[]>(`/workspaces/${id}/audit`),
      ]);
      setMembers(nextMembers.filter((member) => member.status === "active"));
      setInvitations(nextInvites);
      setAudit(nextAudit);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load team data."); }
  }

  useEffect(() => {
    request<Workspace[]>("/workspaces").then((items) => {
      setWorkspaces(items);
      const first = items.find((item) => ["owner", "admin"].includes(item.role));
      if (first) setWorkspaceId(first.id);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Sign in to manage your team."));
  }, []);

  useEffect(() => { if (workspaceId) void load(workspaceId); }, [workspaceId]);

  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true); setError("");
    try {
      await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The team change failed."); }
    finally { setBusy(false); }
  }

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await mutate(`/workspaces/${workspaceId}/invitations`, "POST", { twitchUsername: username, role });
    setUsername("");
  }

  if (!workspaces.length && !error) return <main className="shell"><div className="loading">Loading team…</div></main>;
  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/invitations">Invitation inbox</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">WORKSPACE ACCESS</p><h1>Team management</h1><p className="subheading">Invite collaborators, manage roles, and review workspace access history.</p></div>
      <select aria-label="Workspace" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{workspaces.filter((item) => ["owner", "admin"].includes(item.role)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    </section>
    {error && <div className="error-banner">{error}</div>}
    {selected && <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">INVITE A COLLABORATOR</p><h2>New invitation</h2></div></div>
      <form className="team-invite-form" onSubmit={invite}>
        <label>Twitch username<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="their_twitch_name" required maxLength={25} /></label>
        <label>Workspace role<select value={role} onChange={(event) => setRole(event.target.value)}><option value="moderator">Moderator</option><option value="viewer">Viewer</option>{selected.role === "owner" && <option value="admin">Admin</option>}</select></label>
        <button className="primary-button" disabled={busy || !username.trim()}>Send invitation</button>
      </form>
      <p className="panel-note">Invitations are bound to the resolved Twitch account, appear in the recipient’s inbox, and expire after seven days. Admin invitations can only be issued by the workspace owner.</p>
    </section>}
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h2>Active members</h2></div><span className="count-pill">{members.length}</span></div>
      <div className="team-table"><div className="team-row team-row-head"><span>TWITCH ACCOUNT</span><span>ROLE</span><span>ADDED</span><span>ACTIONS</span></div>
        {members.map((member) => <div className="team-row" key={member.user_id}><strong>{member.role === "owner" ? "Workspace owner" : `Twitch user ${member.twitch_user_id}`}</strong>
          {member.role === "owner" ? <span className="role-label">Owner</span> : <select aria-label={`Role for ${member.twitch_user_id}`} disabled={busy} value={member.role} onChange={(event) => void mutate(`/workspaces/${workspaceId}/members/${member.user_id}`, "PATCH", { role: event.target.value })}>{selected?.role === "owner" && <option value="admin">Admin</option>}<option value="moderator">Moderator</option><option value="viewer">Viewer</option></select>}
          <span>{new Date(member.created_at).toLocaleDateString()}</span>
          {member.role === "owner" ? <span className="role-label">Protected</span> : <button className="text-button danger-text" disabled={busy} onClick={() => { if (window.confirm("Revoke this member’s workspace access?")) void mutate(`/workspaces/${workspaceId}/members/${member.user_id}`, "DELETE"); }}>Revoke</button>}
        </div>)}
        {!members.length && <p className="panel-note">No active members found.</p>}
      </div>
    </section>
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">PENDING ACCESS</p><h2>Invitations</h2></div><span className="count-pill">{invitations.length}</span></div>
      {invitations.map((item) => <div className="connection-row" key={item.id}><div className="connection-copy"><strong>{item.assigned_role} invitation · Twitch ID {item.invited_twitch_user_id}</strong><small>Expires {new Date(item.expires_at).toLocaleString()}</small></div><button className="text-button" disabled={busy} onClick={() => void mutate(`/workspaces/${workspaceId}/invitations/${item.id}/resend`, "POST")}>Resend</button><button className="text-button danger-text" disabled={busy} onClick={() => void mutate(`/workspaces/${workspaceId}/invitations/${item.id}`, "DELETE")}>Cancel</button></div>)}
      {!invitations.length && <p className="panel-note">No pending invitations.</p>}
    </section>
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">ACCOUNTABILITY</p><h2>Recent team activity</h2></div></div>
      {audit.map((event) => <div className="audit-row" key={event.id}><div><strong>{event.event_type.replaceAll(".", " ").replaceAll("_", " ")}</strong><small>{event.actor_twitch_user_id ? `Actor Twitch ID ${event.actor_twitch_user_id}` : "System"} · {event.target_type ?? "workspace"} {event.target_id ?? ""}</small></div><time>{new Date(event.created_at).toLocaleString()}</time></div>)}
      {!audit.length && <p className="panel-note">No audit events have been recorded yet.</p>}
    </section>
  </main>;
}
