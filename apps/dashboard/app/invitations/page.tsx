"use client";

import { useEffect, useState } from "react";

type Invitation = { id: string; workspace_id: string; workspace_name: string; assigned_role: string; created_at: string; expires_at: string };
const API = "/api";
function csrf() { return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? ""; }

export default function InvitationInboxPage() {
  const [items, setItems] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  async function load() {
    const response = await fetch(`${API}/me/invitations`, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error("Sign in to view your invitations.");
    setItems(await response.json() as Invitation[]);
  }
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load invitations.")); }, []);
  async function respond(id: string, action: "accept" | "decline") {
    setBusy(id); setError("");
    try {
      const response = await fetch(`${API}/me/invitations/${id}/${action}`, { method: "POST", credentials: "include", headers: { "x-csrf-token": csrf() } });
      if (!response.ok) throw new Error("This invitation could not be processed. It may have expired or already been answered.");
      await load();
      if (action === "accept") window.location.assign("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not respond to invitation."); }
    finally { setBusy(""); }
  }
  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team management</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">YOUR ACCOUNT</p><h1>Invitation inbox</h1><p className="subheading">Workspace invitations are addressed to your signed-in Twitch identity.</p></div></section>
    {error && <div className="error-banner">{error}</div>}
    <section className="panel team-panel">
      {items.map((item) => <article className="invitation-card" key={item.id}><div><p className="eyebrow">{item.assigned_role}</p><h2>{item.workspace_name}</h2><p className="panel-note">Invited {new Date(item.created_at).toLocaleDateString()} · Expires {new Date(item.expires_at).toLocaleDateString()}</p></div><div className="invitation-actions"><button className="primary-button" disabled={Boolean(busy)} onClick={() => void respond(item.id, "accept")}>{busy === item.id ? "Working…" : "Accept"}</button><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void respond(item.id, "decline")}>Decline</button></div></article>)}
      {!items.length && <div className="quiet-empty"><span>✉</span><p>You’re all caught up.</p><small>No pending workspace invitations.</small></div>}
    </section>
  </main>;
}
