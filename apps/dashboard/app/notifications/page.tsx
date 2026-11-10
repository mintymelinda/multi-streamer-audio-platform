"use client";

import { useCallback, useEffect, useState } from "react";

type Workspace = { id: string; name: string };
type Notification = {
  id: string; workspace_id: string | null; category: string; priority: string; event_type: string;
  title: string; body: string; href: string | null; group_key: string | null;
  notification_count: number; unread_count: number; is_read: boolean; created_at: string;
  group_window: number | null; email_delivery_status: string | null;
  email_delivery_attempt_count: number | null; email_delivery_next_attempt_at: string | null;
  email_delivery_sent_at: string | null;
};
const API = "/api";
function csrf() { return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? ""; }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrf());
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in to view notifications." : `Request failed (${response.status}).`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
function queryString(filters: { category: string; priority: string; workspaceId: string; unread: boolean }) {
  const query = new URLSearchParams();
  if (filters.category) query.set("category", filters.category);
  if (filters.priority) query.set("priority", filters.priority);
  if (filters.workspaceId) query.set("workspaceId", filters.workspaceId);
  if (filters.unread) query.set("unread", "true");
  return query.toString();
}
function displayCategory(value: string) { return value.replaceAll("_", " "); }

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [unread, setUnread] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [categoryPreferences, setCategoryPreferences] = useState<Record<string, boolean>>({});
  const [retentionDays, setRetentionDays] = useState(90);
  const [preferenceMessage, setPreferenceMessage] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [savedEmailAddress, setSavedEmailAddress] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailCategories, setEmailCategories] = useState<Record<string, boolean>>({});
  const [emailPriorities, setEmailPriorities] = useState<Record<string, boolean>>({});
  const [verificationToken, setVerificationToken] = useState("");
  const [emailMessage, setEmailMessage] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const qs = queryString({ category, priority, workspaceId, unread });
      const [notifications, count] = await Promise.all([
        request<Notification[]>(`/me/notifications${qs ? `?${qs}` : ""}`),
        request<{ unreadCount: number }>("/me/notifications/unread-count"),
      ]);
      setItems(notifications);
      setUnreadCount(count.unreadCount);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load notifications."); }
  }, [category, priority, workspaceId, unread]);

  useEffect(() => {
    request<Workspace[]>("/workspaces").then(setWorkspaces).catch(() => setWorkspaces([]));
    request<{ category_preferences: Record<string, boolean>; retention_days: number }>("/me/notifications/preferences")
      .then((preferences) => { setCategoryPreferences(preferences.category_preferences ?? {}); setRetentionDays(preferences.retention_days ?? 90); })
      .catch((cause) => setPreferenceMessage(cause instanceof Error ? cause.message : "Could not load preferences."));
    request<{ emailAddress: string | null; verified: boolean; emailEnabled: boolean; categoryPreferences: Record<string, boolean>; priorityPreferences: Record<string, boolean> }>("/me/notifications/email")
      .then((settings) => { setSavedEmailAddress(settings.emailAddress); setEmailVerified(settings.verified); setEmailEnabled(settings.emailEnabled); setEmailCategories(settings.categoryPreferences ?? {}); setEmailPriorities(settings.priorityPreferences ?? {}); })
      .catch((cause) => setEmailMessage(cause instanceof Error ? cause.message : "Could not load email settings."));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function markRead(item: Notification) {
    setBusy(true);
    try {
      if (item.group_key && item.notification_count > 1) {
        await request("/me/notifications/groups/read", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupKey: item.group_key, groupWindow: item.group_window }) });
      } else {
        await request(`/me/notifications/${item.id}/read`, { method: "PATCH" });
      }
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not mark notification read."); }
    finally { setBusy(false); }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      const query = new URLSearchParams();
      if (category) query.set("category", category);
      if (priority) query.set("priority", priority);
      if (workspaceId) query.set("workspaceId", workspaceId);
      await request(`/me/notifications/read-all${query.size ? `?${query}` : ""}`, { method: "PATCH" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not mark notifications read."); }
    finally { setBusy(false); }
  }

  return <main className="shell">
    <header className="topbar"><a className="brand" href="/">♫ Streamer Audio</a><nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team</a><a href="/invitations">Invitations</a></nav></header>
    <section className="welcome"><div><p className="eyebrow">YOUR ACCOUNT</p><h1>Notifications</h1><p className="subheading">Updates addressed to you across your workspaces and the platform.</p></div><span className="count-pill">{unreadCount} unread</span></section>
    {error && <div className="error-banner">{error}</div>}
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">PREFERENCES</p><h2>Notification settings</h2></div></div>
      <p className="subheading">Account and security notifications are always retained and cannot be disabled.</p>
      <div className="notification-filters">
        {["platform","team","provider","playback","queue","system"].map((value) => <label className="notification-unread" key={value}>
          <input type="checkbox" checked={categoryPreferences[value] !== false} onChange={(event) => setCategoryPreferences((current) => ({ ...current, [value]: event.target.checked }))} /> {displayCategory(value)}
        </label>)}
        <label>Keep other notifications for<select value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))}>
          {[30,90,180,365].map((days) => <option key={days} value={days}>{days} days</option>)}
        </select></label>
        <button className="secondary-button" disabled={busy} onClick={async () => {
          setBusy(true); setPreferenceMessage("");
          try {
            const saved = await request<{ category_preferences: Record<string, boolean>; retention_days: number }>("/me/notifications/preferences", {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ categoryPreferences, retentionDays }),
            });
            setCategoryPreferences(saved.category_preferences); setRetentionDays(saved.retention_days);
            setPreferenceMessage("Notification preferences saved.");
          } catch (cause) { setPreferenceMessage(cause instanceof Error ? cause.message : "Could not save preferences."); }
          finally { setBusy(false); }
        }}>Save preferences</button>
      </div>
      {preferenceMessage && <p role="status">{preferenceMessage}</p>}
    </section>
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">OPTIONAL DELIVERY</p><h2>Email notifications</h2></div></div>
      <p className="subheading">Email is separate from Twitch sign-in. Verify an address you choose, then opt in to the categories and priorities you want delivered.</p>
      <form className="notification-filters" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setEmailMessage("");
        try {
          await request("/me/notifications/email/verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emailAddress }) });
          setSavedEmailAddress(emailAddress); setEmailVerified(false); setEmailEnabled(false); setEmailMessage("Verification email queued. Check your inbox and enter the code below.");
        } catch (cause) { setEmailMessage(cause instanceof Error ? cause.message : "Could not request verification."); }
        finally { setBusy(false); }
      }}>
        <label>Email address<input type="email" required value={emailAddress} onChange={(event) => setEmailAddress(event.target.value)} placeholder="you@example.com" /></label>
        <button className="secondary-button" disabled={busy}>Send verification code</button>
      </form>
      <form className="notification-filters" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setEmailMessage("");
        try {
          await request("/me/notifications/email/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: verificationToken }) });
          setEmailVerified(true); setEmailMessage("Email address verified. Choose your delivery preferences and save.");
        } catch (cause) { setEmailMessage(cause instanceof Error ? cause.message : "Could not verify email address."); }
        finally { setBusy(false); }
      }}>
        <label>Verification code<input value={verificationToken} onChange={(event) => setVerificationToken(event.target.value)} placeholder="Paste the code from your email" /></label>
        <button className="secondary-button" disabled={busy || !verificationToken}>Verify address</button>
      </form>
      <p>{emailVerified ? "Email address verified." : "Email address not verified."}</p>
      <label className="notification-unread"><input type="checkbox" checked={emailEnabled} disabled={!emailVerified} onChange={(event) => setEmailEnabled(event.target.checked)} /> Enable email notifications</label>
      <p className="subheading">Choose categories and priorities. Nothing is emailed until the address is verified and email delivery is enabled.</p>
      <div className="notification-filters">
        <strong>Categories</strong>
        {["account","platform","security","team","provider","playback","queue","system"].map((value) => <label className="notification-unread" key={value}>
          <input type="checkbox" checked={emailCategories[value] === true} onChange={(event) => setEmailCategories((current) => ({ ...current, [value]: event.target.checked }))} /> {displayCategory(value)}
        </label>)}
        <strong>Priorities</strong>
        {["low","normal","high","critical"].map((value) => <label className="notification-unread" key={value}>
          <input type="checkbox" checked={emailPriorities[value] === true} onChange={(event) => setEmailPriorities((current) => ({ ...current, [value]: event.target.checked }))} /> {value}
        </label>)}
        <button className="secondary-button" disabled={busy || (emailEnabled && !emailVerified)} onClick={async () => {
          setBusy(true); setEmailMessage("");
          try {
            const saved = await request<{ emailEnabled: boolean; verified: boolean; categoryPreferences: Record<string, boolean>; priorityPreferences: Record<string, boolean> }>("/me/notifications/email", {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ emailEnabled, categoryPreferences: emailCategories, priorityPreferences: emailPriorities }),
            });
            setEmailEnabled(saved.emailEnabled); setEmailVerified(saved.verified);
            setEmailCategories(saved.categoryPreferences); setEmailPriorities(saved.priorityPreferences);
            setEmailMessage("Email preferences saved.");
          } catch (cause) { setEmailMessage(cause instanceof Error ? cause.message : "Could not save email preferences."); }
          finally { setBusy(false); }
        }}>Save email preferences</button>
      </div>
      {emailMessage && <p role="status">{emailMessage}</p>}
    </section>
    <section className="panel team-panel">
      <div className="panel-heading"><div><p className="eyebrow">INBOX</p><h2>Notification history</h2></div><button className="secondary-button" onClick={() => void markAllRead()} disabled={busy || unreadCount === 0}>Mark all read</button></div>
      <div className="notification-filters">
        <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{["account","platform","security","team","provider","playback","queue","system"].map((value) => <option key={value} value={value}>{displayCategory(value)}</option>)}</select></label>
        <label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{["low","normal","high","critical"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Workspace<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">All workspaces</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        <label className="notification-unread"><input type="checkbox" checked={unread} onChange={(event) => setUnread(event.target.checked)} /> Unread only</label>
      </div>
      {items.length ? <div className="notification-list">{items.map((item) => <article className={`notification-row ${item.is_read ? "is-read" : "is-unread"}`} key={item.id}>
        <div className="notification-mark">{item.is_read ? "·" : "●"}</div>
        <div className="notification-content"><div className="notification-meta"><span>{displayCategory(item.category)}</span><span className={`priority-${item.priority}`}>{item.priority}</span>{item.notification_count > 1 && <span>{item.notification_count} related events</span>}</div>
          <strong>{item.title}</strong>{item.body && <p>{item.body}</p>}<small>{item.workspace_id ? "Workspace notification" : "Account / platform"} · {new Date(item.created_at).toLocaleString()}</small>
          {item.email_delivery_status && <small>Email delivery: {item.email_delivery_status} · {item.email_delivery_attempt_count ?? 0} attempts{item.email_delivery_sent_at ? ` · sent ${new Date(item.email_delivery_sent_at).toLocaleString()}` : ""}</small>}
          {item.href && <a href={item.href}>View details</a>}
        </div>
        {!item.is_read && <button className="text-button" disabled={busy} onClick={() => void markRead(item)}>Mark read</button>}
      </article>)}</div> : <div className="quiet-empty"><span>♫</span><p>No notifications match these filters.</p><small>New updates addressed to you will appear here.</small></div>}
    </section>
    <footer className="footer"><span>Personal notification inbox</span><a href="/">Back to dashboard</a></footer>
  </main>;
}
