"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Workspace = {
  id: string;
  name: string;
  status: "active" | "restricted" | "suspended";
  role: "owner" | "admin" | "moderator" | "viewer";
};
type RequestItem = {
  id: string;
  title: string;
  artist?: string | null;
  status: string;
  submitted_at?: string;
  requester_display_name?: string | null;
};
type Snapshot = { requests: RequestItem[]; queue: RequestItem[] };
type PublicIncident = { id: string; title: string; summary: string; status: string; impact: string; affected_services: string[]; updated_at: string };
type ServiceStatus = { status: string; incidents: PublicIncident[] };
type Onboarding = { dismissed: boolean; completed: boolean; progress: { completed: number; skipped: number; total: number }; steps: { key: string; title: string; description: string; status: "pending" | "completed" | "skipped" }[] };
type TwitchStatus = {
  status: "connected" | "reauth_required" | "disconnected" | "error";
  recoveryState: "ready" | "paused" | "pending_reconciliation";
  externalAccountId: string | null;
  lastValidatedAt: string | null;
};

const API = "/api";

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in to view your workspace." : `Request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

function statusTone(status: string) {
  if (["connected", "active", "ready", "playing"].includes(status)) return "good";
  if (["degraded", "pending_reconciliation", "restricted"].includes(status)) return "warning";
  return "muted";
}

function Status({ value, label }: { value: string; label?: string }) {
  return <span className={`status status--${statusTone(value)}`}><span />{label ?? value.replaceAll("_", " ")}</span>;
}

export default function HomePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [twitch, setTwitch] = useState<TwitchStatus | null>(null);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [account, setAccount] = useState(false);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const selected = useMemo(() => workspaces.find((workspace) => workspace.id === selectedId), [workspaces, selectedId]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError("");
    try {
      const me = await api<{ user: { id: string } }>("/auth/me");
      setAccount(Boolean(me.user.id));
      const [adminAccess, publicStatus] = await Promise.all([
        api<{ isPlatformAdministrator: boolean }>("/platform-admin/me").catch(() => ({ isPlatformAdministrator: false })),
        api<ServiceStatus>("/status").catch(() => null),
      ]);
      setPlatformAdmin(adminAccess.isPlatformAdministrator);
      setServiceStatus(publicStatus);
      const available = await api<Workspace[]>("/workspaces");
      setWorkspaces(available);
      const activeId = selectedId && available.some((workspace) => workspace.id === selectedId)
        ? selectedId
        : available[0]?.id ?? "";
      setSelectedId(activeId);
      if (!activeId) {
        setSnapshot(null);
        setTwitch(null);
        setOnboarding(null);
        return;
      }
      const [data, twitchStatus, setup] = await Promise.all([
        api<Snapshot>(`/workspaces/${activeId}/realtime/snapshot`),
        api<TwitchStatus>(`/workspaces/${activeId}/twitch/authorization`).catch(() => null),
        api<Onboarding>(`/workspaces/${activeId}/onboarding`).catch(() => null),
      ]);
      setSnapshot(data);
      setTwitch(twitchStatus);
      setOnboarding(setup);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dashboard could not be loaded.");
      setAccount(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedId]);

  useEffect(() => { void load(); }, [load]);

  const queued = snapshot?.queue ?? [];
  const playing = snapshot?.requests.filter((request) => request.status === "playing") ?? [];
  const pending = snapshot?.requests.filter((request) => ["pending", "held"].includes(request.status)) ?? [];
  const warnings = [
    selected?.status !== "active" ? "This workspace is not active. Playback and request handling may be restricted." : "",
    !twitch || twitch.status !== "connected" ? "Twitch channel authorization needs attention." : "",
    twitch?.recoveryState === "paused" ? "Workspace activity is paused pending Twitch authorization recovery." : "",
    pending.length ? `${pending.length} request(s) are waiting for moderation.` : "",
  ].filter(Boolean);

  if (loading) return <main className="shell"><div className="loading">Loading your workspace…</div></main>;

  if (!account) return (
    <main className="shell auth-shell">
      <div className="brand-mark">♫</div>
      <p className="eyebrow">STREAMER AUDIO PLATFORM</p>
      <h1>Your channel.<br />Your sound.</h1>
      <p className="intro">Manage requests, playback, and your stream audio workspace in one place.</p>
      {error && <p className="error">{error}</p>}
      <a className="primary-button" href={`${API}/auth/twitch/start?returnTo=%2F`}>Continue with Twitch</a>
    </main>
  );

  if (!workspaces.length) return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span>♫</span> Streamer Audio</div><nav className="page-nav"><a href="/status">Service status</a>{platformAdmin && <a href="/platform-admin">Platform administration</a>}<a href={`${API}/auth/twitch/start?returnTo=%2F`}>Reconnect</a></nav></header>
      <section className="empty-state">
        <p className="eyebrow">WELCOME</p><h1>Create your workspace</h1>
        <p>Your Twitch account is already linked as the channel identity. Choose a workspace name to complete the essential setup; you can configure providers, rewards, moderation, and overlays afterward.</p>
        <CreateWorkspace onCreated={() => void load()} />
      </section>
    </main>
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span>♫</span> Streamer Audio</div>
        <div className="top-actions">
          <label className="workspace-picker"><span>WORKSPACE</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <nav className="page-nav">{platformAdmin && <a href="/platform-admin">Platform administration</a>}{selected?.role === "owner" && <a href={`/support-access?workspaceId=${encodeURIComponent(selectedId)}`}>Support access</a>}<a href="/team">Team</a><a href="/invitations">Invitations</a><a href="/notifications">Notifications</a><a href="/scenes">Scenes</a><a href="/settings">Settings</a></nav><button className="icon-button" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh dashboard">↻</button>
        </div>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">OVERVIEW</p><h1>{selected?.name ?? "Your workspace"}</h1><p className="subheading">A current view of your channel audio and request activity.</p></div>
        <div className="workspace-meta"><Status value={selected?.status ?? "unknown"} /> <span>{selected?.role}</span></div>
      </section>
      {error && <div className="error-banner">{error}</div>}
      {serviceStatus?.incidents.filter((incident) => incident.status !== "resolved").map((incident) => (
        <section className="incident-notice" key={incident.id}>
          <div className="incident-notice-heading"><strong>{incident.title}</strong><span>{incident.status.replaceAll("_", " ")}</span></div>
          <p>{incident.summary}</p>
          <a href="/status">View service status and updates</a>
        </section>
      ))}
      {!serviceStatus && <p className="panel-note"><a href="/status">Service status is currently unavailable.</a></p>}
      {selected && ["owner", "admin"].includes(selected.role) && onboarding && !onboarding.completed && (
        <section className="onboarding-panel">
          <div className="onboarding-head">
            <div><p className="eyebrow">GETTING STARTED</p><h2>Finish setting up your workspace</h2><p>Essentials are in place. Work through these steps now or skip them and come back whenever you’re ready.</p></div>
            <span className="onboarding-progress">{onboarding.progress.completed + onboarding.progress.skipped}/{onboarding.progress.total}</span>
          </div>
          {onboarding.dismissed ? (
            <button className="secondary-button" onClick={() => void updateOnboarding(selectedId, { dismissed: false }).then(setOnboarding).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not resume setup."))}>Resume setup</button>
          ) : (
            <>
              <div className="onboarding-steps">{onboarding.steps.map((step, index) => (
                <div className="onboarding-step" key={step.key}>
                  <span className="onboarding-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="onboarding-copy"><strong>{step.title}</strong><small>{step.description}</small></div>
                  <Status value={step.status} label={step.status === "pending" ? "Not started" : step.status} />
                  <div className="onboarding-actions">
                    {step.status !== "completed" && <button onClick={() => void updateOnboarding(selectedId, { step: step.key, status: "completed" }).then(setOnboarding).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not save setup progress."))}>Done</button>}
                    {step.status !== "skipped" && <button className="text-button" onClick={() => void updateOnboarding(selectedId, { step: step.key, status: "skipped" }).then(setOnboarding).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not save setup progress."))}>Skip</button>}
                  </div>
                </div>
              ))}</div>
              <button className="text-button dismiss-setup" onClick={() => void updateOnboarding(selectedId, { dismissed: true }).then(setOnboarding).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not hide setup."))}>Hide checklist for now</button>
            </>
          )}
        </section>
      )}
      {warnings.length > 0 && <section className="warnings"><div className="warning-heading"><span>!</span><strong>Needs attention</strong><span>{warnings.length}</span></div>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
      <section className="metric-grid">
        <article className="metric-card"><span className="metric-label">PLAYING NOW</span><strong>{playing.length ? playing[0]?.title : "Nothing playing"}</strong><small>{playing[0]?.artist || (playing.length ? "Current request" : "No active playback reported")}</small><Status value={playing.length ? "playing" : "idle"} label={playing.length ? "Playing" : "Idle"} /></article>
        <article className="metric-card"><span className="metric-label">UP NEXT</span><strong>{queued.length}</strong><small>Requests in the playable queue</small><span className="metric-foot">Queue capacity is managed by workspace settings</span></article>
        <article className="metric-card"><span className="metric-label">AWAITING REVIEW</span><strong>{pending.length}</strong><small>Requests pending moderation</small><span className="metric-foot">{pending.length ? "Moderator attention may be needed" : "No pending moderation"}</span></article>
      </section>
      <section className="section-grid">
        <article className="panel">
          <div className="panel-heading"><div><p className="eyebrow">CONNECTIONS</p><h2>Service status</h2></div></div>
          <div className="connection-row"><div className="service-icon twitch">T</div><div className="connection-copy"><strong>Twitch channel</strong><small>{twitch?.externalAccountId ? `Account ${twitch.externalAccountId}` : "Broadcaster authorization"}</small></div><Status value={twitch?.status ?? "unknown"} label={twitch?.status?.replaceAll("_", " ") ?? "Not available"} /></div>
          <div className="connection-row"><div className="service-icon spotify">S</div><div className="connection-copy"><strong>Spotify Connect</strong><small>Personal playback authorization</small></div><Status value="not_reported" label="Status unavailable" /></div>
          <p className="panel-note">Only integrations with an implemented status endpoint are reported as connected. Spotify connection controls are available separately; this dashboard does not infer connection health.</p>
          {twitch?.status !== "connected" && selected?.role === "owner" && <p className="panel-note">Reconnect authorization is managed from the Twitch integration settings.</p>}
        </article>
        <article className="panel queue-panel">
          <div className="panel-heading"><div><p className="eyebrow">REQUESTS</p><h2>Coming up</h2></div><span className="count-pill">{queued.length}</span></div>
          {queued.length ? <ol className="queue-list">{queued.slice(0, 5).map((request, index) => <li key={request.id}><span className="queue-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{request.title}</strong><small>{request.artist || "Unknown artist"}</small></div><Status value={request.status} /></li>)}</ol> : <div className="quiet-empty"><span>♫</span><p>Your queue is clear.</p><small>Approved requests will appear here.</small></div>}
        </article>
      </section>
      <footer className="footer"><span>Workspace dashboard</span><span>Updates when you refresh</span></footer>
    </main>
  );
}

async function updateOnboarding(workspaceId: string, body: { step?: string; status?: string; dismissed?: boolean }): Promise<Onboarding> {
  const csrf = document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
  const path = body.step ? `/workspaces/${workspaceId}/onboarding/steps/${body.step}` : `/workspaces/${workspaceId}/onboarding`;
  const response = await fetch(`${API}${path}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("Could not save onboarding progress.");
  return response.json() as Promise<Onboarding>;
}

function CreateWorkspace({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch(`${API}/workspaces`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "x-csrf-token": document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("Workspace creation failed. Please try again.");
      onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Workspace creation failed."); }
    finally { setBusy(false); }
  }
  return <form className="create-form" onSubmit={submit}><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Workspace name" required /><button className="primary-button" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create workspace"}</button>{error && <p className="error">{error}</p>}</form>;
}
