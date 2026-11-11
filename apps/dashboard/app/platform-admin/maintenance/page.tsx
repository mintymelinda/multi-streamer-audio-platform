"use client";

import { useCallback, useEffect, useState } from "react";

type Access = { isPlatformAdministrator: boolean; permissions: string[] };
type Maintenance = {
  id: string; title: string; summary: string; expected_impact: string;
  affected_services: string[]; starts_at: string; ends_at: string | null;
  state: "scheduled" | "in_progress" | "completed" | "cancelled";
};
type FormState = {
  title: string; summary: string; expectedImpact: string; affectedServices: string[];
  startsAt: string; endsAt: string;
};
const API = "/api";
const SERVICES = [
  ["all", "All services"], ["api", "API"], ["dashboard", "Dashboard"],
  ["overlay", "OBS overlay"], ["playback", "Playback"], ["authentication", "Authentication"],
  ["twitch", "Twitch"], ["spotify", "Spotify"], ["lyrion", "Lyrion"],
] as const;
const EMPTY: FormState = { title: "", summary: "", expectedImpact: "", affectedServices: ["all"], startsAt: "", endsAt: "" };

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new Error(typeof payload?.message === "string" ? payload.message : `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
function toLocalInput(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
function displayDate(value: string) { return new Date(value).toLocaleString(); }

export default function PlannedMaintenancePage() {
  const [access, setAccess] = useState<Access | null>(null);
  const [items, setItems] = useState<Maintenance[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const current = await request<Access>("/platform-admin/me");
      setAccess(current);
      if (current.isPlatformAdministrator && current.permissions.includes("status.manage")) {
        setItems(await request<Maintenance[]>("/platform-admin/maintenance"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load planned maintenance.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function edit(item: Maintenance) {
    setEditingId(item.id);
    setForm({
      title: item.title, summary: item.summary, expectedImpact: item.expected_impact,
      affectedServices: item.affected_services, startsAt: toLocalInput(item.starts_at),
      endsAt: item.ends_at ? toLocalInput(item.ends_at) : "",
    });
    setMessage("");
  }
  function toggleService(service: string) {
    setForm((current) => {
      const selected = current.affectedServices.includes(service)
        ? current.affectedServices.filter((value) => value !== service)
        : [...current.affectedServices.filter((value) => value !== "all" && service !== "all"), service];
      return { ...current, affectedServices: selected };
    });
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await request("/platform-admin/maintenance", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form, id: editingId,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        }),
      });
      setForm(EMPTY); setEditingId(null);
      setMessage("Maintenance notice published. A platform notification has been sent to active accounts.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not publish maintenance notice."); }
    finally { setBusy(false); }
  }
  async function cancel(item: Maintenance) {
    if (!window.confirm(`Cancel the planned maintenance “${item.title}”? Users who received the notice will be informed.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await request(`/platform-admin/maintenance/${item.id}`, { method: "DELETE" });
      setMessage("Maintenance cancelled and cancellation notices published.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel maintenance."); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="shell"><div className="loading">Loading planned maintenance…</div></main>;
  return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span>♫</span> Streamer Audio</div><nav className="page-nav"><a href="/platform-admin">Platform administration</a><a href="/platform-admin/incidents">Service incidents</a><a href="/status">Public status</a><a href="/">Workspace dashboard</a></nav></header>
      <section className="welcome"><div><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Planned maintenance</h1><p className="subheading">Schedule service work, publish expected impact and time windows, and notify users before the interruption.</p></div></section>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {message && <div className="success-banner" role="status">{message}</div>}
      {!access?.isPlatformAdministrator || !access.permissions.includes("status.manage") ? (
        <section className="panel"><h2>Access restricted</h2><p>This account does not have permission to manage planned maintenance.</p></section>
      ) : <>
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">{editingId ? "UPDATE NOTICE" : "ADVANCE NOTICE"}</p><h2>{editingId ? "Update planned maintenance" : "Schedule maintenance"}</h2></div>{editingId && <button className="text-button" type="button" onClick={() => { setEditingId(null); setForm(EMPTY); }}>Cancel edit</button>}</div>
          <form className="settings-form" onSubmit={save}>
            <label>Public title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} minLength={5} maxLength={160} required /></label>
            <label>Details<textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} minLength={10} maxLength={2000} rows={3} required /></label>
            <label>Expected impact<textarea value={form.expectedImpact} onChange={(event) => setForm({ ...form, expectedImpact: event.target.value })} minLength={5} maxLength={1000} rows={2} required placeholder="Which features may be unavailable or degraded?" /></label>
            <div className="incident-form-grid">
              <label>Expected start (your local time)<input type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} required /></label>
              <label>Expected end (optional)<input type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></label>
            </div>
            <fieldset><legend>Affected services</legend><div className="incident-service-options">{SERVICES.map(([key, label]) => <label className="checkbox-row" key={key}><input type="checkbox" checked={form.affectedServices.includes(key)} onChange={() => toggleService(key)} />{label}</label>)}</div></fieldset>
            <button className="primary-button" type="submit" disabled={busy || !form.title.trim() || !form.summary.trim() || !form.expectedImpact.trim() || !form.startsAt || !form.affectedServices.length}>{busy ? "Publishing…" : editingId ? "Publish updated notice" : "Publish advance notice"}</button>
          </form>
          <p className="subheading">Publishing sends a high-priority in-app notification to active platform accounts. Email is sent only to users who have verified an address and opted into high-priority platform email.</p>
        </section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">COMMUNICATION HISTORY</p><h2>Maintenance notices</h2></div><a href="/status">View public page</a></div>
          {items.length === 0 ? <div className="quiet-empty"><p>No maintenance notices</p><small>Scheduled work will appear here.</small></div> : items.map((item) => (
            <article className="status-incident" key={item.id}>
              <div className="status-incident-heading"><div><h3>{item.title}</h3><div className="status-incident-meta"><span>{item.state.replaceAll("_", " ")}</span><span>{item.affected_services.join(", ")}</span></div></div><span>{displayDate(item.starts_at)}</span></div>
              <p>{item.summary}</p><p><strong>Expected impact:</strong> {item.expected_impact}</p>
              <small>{item.ends_at ? `Expected end: ${displayDate(item.ends_at)}` : "End time not yet confirmed"}</small>
              <div className="button-row">{item.state === "scheduled" && <button className="secondary-button" disabled={busy} onClick={() => edit(item)}>Edit / reschedule</button>}{item.state === "scheduled" && <button className="text-button" disabled={busy} onClick={() => void cancel(item)}>Cancel maintenance</button>}</div>
            </article>
          ))}
        </section>
      </>}
    </main>
  );
}
