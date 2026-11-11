"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Workspace = { id: string; name: string; role: "owner" | "admin" | "moderator" | "viewer" };
type Scene = {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  token_created_at: string | null;
  token_revoked_at: string | null;
  has_active_access: boolean;
};
type SceneSecret = { sceneId: string; url: string };
type SceneEditor = { sceneId: string; name: string; draftState: Record<string, unknown>; draftRevision: number; publishedAt: string | null; updatedAt: string; hasPublishedState: boolean };
type SceneIssue = { scene: Scene; accessToken: string; overlayPath: string };
type StarterSceneResult = { scene: Scene; accessToken: string | null; overlayPath: string; created: boolean };
type ComponentType = "now-playing" | "request-queue" | "recent-tracks" | "announcement" | "custom-text" | "custom-image" | "background" | "decoration";
const COMPONENT_LIBRARY: { type: ComponentType; label: string; description: string }[] = [
  { type: "now-playing", label: "Now Playing", description: "Current track information and progress" },
  { type: "request-queue", label: "Request Queue", description: "Upcoming requested tracks" },
  { type: "recent-tracks", label: "Recent Tracks", description: "Recently played tracks" },
  { type: "announcement", label: "Announcement", description: "A streamer announcement or notice" },
  { type: "custom-text", label: "Custom Text", description: "A text label with editable content" },
  { type: "custom-image", label: "Custom Image", description: "An image from a URL" },
  { type: "background", label: "Background", description: "A scene background layer" },
  { type: "decoration", label: "Decoration", description: "A decorative visual element" },
];

const API = "/api";
const OVERLAY_BASE = process.env.NEXT_PUBLIC_OVERLAY_BASE_URL;

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
    const message = response.status === 401
      ? "Sign in to manage overlay scenes."
      : response.status === 403
        ? "You need workspace administrator permissions to manage scenes."
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function previewPercent(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function obsUrl(path: string, token: string) {
  const base = (OVERLAY_BASE || window.location.origin).replace(/\/+$/, "");
  return `${base}${path}#${token}`;
}

export default function ScenesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [name, setName] = useState("Now Playing");
  const [secrets, setSecrets] = useState<SceneSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<SceneEditor | null>(null);
  const [draftText, setDraftText] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const starterRequests = useRef(new Set<string>());
  const previewStage = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ index: number; pointerId: number; mode: "move" | "resize"; startX: number; startY: number; x: number; y: number; width: number; height: number } | null>(null);

  const loadScenes = useCallback(async () => {
    if (!workspaceId) {
      setScenes([]);
      return;
    }
    setError("");
    try {
      setScenes(await request<Scene[]>(`/workspaces/${workspaceId}/scenes`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load scenes.");
    }
  }, [workspaceId]);

  useEffect(() => {
    request<Workspace[]>("/workspaces")
      .then((available) => {
        setWorkspaces(available);
        setWorkspaceId(available[0]?.id ?? "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load workspaces."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void loadScenes(); }, [loadScenes]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const canManage = selectedWorkspace && ["owner", "admin"].includes(selectedWorkspace.role);

  useEffect(() => {
    if (!workspaceId || !canManage || starterRequests.current.has(workspaceId)) return;
    starterRequests.current.add(workspaceId);
    request<StarterSceneResult>(
      `/workspaces/${workspaceId}/scenes/starter`,
      { method: "POST" },
    )
      .then(async (result) => {
        const accessToken = result.accessToken;
        if (result.created && accessToken) {
          setSecrets((current) => [
            ...current.filter((secret) => secret.sceneId !== result.scene.id),
            { sceneId: result.scene.id, url: obsUrl(result.overlayPath, accessToken) },
          ]);
          setMessage("Your starter Now Playing scene is ready. Copy its OBS URL now; the access token is shown only once.");
        }
        await loadScenes();
      })
      .catch((cause) => {
        starterRequests.current.delete(workspaceId);
        setError(cause instanceof Error ? cause.message : "Could not prepare the starter scene.");
      });
  }, [workspaceId, canManage, loadScenes]);

  function rememberSecret(sceneId: string, overlayPath: string, accessToken: string) {
    setSecrets((current) => [
      ...current.filter((secret) => secret.sceneId !== sceneId),
      { sceneId, url: obsUrl(overlayPath, accessToken) },
    ]);
  }

  async function createScene(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<SceneIssue>(`/workspaces/${workspaceId}/scenes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      rememberSecret(result.scene.id, result.overlayPath, result.accessToken);
      setName("");
      setMessage("Scene created. Copy its OBS URL now; the access token is shown only once.");
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the scene.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateToken(scene: Scene) {
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<SceneIssue>(`/workspaces/${workspaceId}/scenes/${scene.id}/access-token`, { method: "POST" });
      rememberSecret(scene.id, result.overlayPath, result.accessToken);
      setMessage(`A new OBS URL was issued for ${scene.name}. The previous token is invalid immediately.`);
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rotate the scene token.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(scene: Scene) {
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(`/workspaces/${workspaceId}/scenes/${scene.id}/access-token`, { method: "DELETE" });
      setSecrets((current) => current.filter((secret) => secret.sceneId !== scene.id));
      setMessage(`OBS access revoked for ${scene.name}.`);
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the scene token.");
    } finally {
      setBusy(false);
    }
  }

  async function openEditor(scene: Scene) {
    if (!workspaceId) return;
    setEditorBusy(true);
    setError("");
    try {
      const result = await request<SceneEditor>(`/workspaces/${workspaceId}/scenes/${scene.id}/editor`);
      setEditor(result);
      setDraftText(JSON.stringify(result.draftState, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the scene editor.");
    } finally {
      setEditorBusy(false);
    }
  }

  const previewState = (() => {
    try {
      const parsed: unknown = JSON.parse(draftText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  })();
  const previewElements = previewState && Array.isArray(previewState.elements)
    ? previewState.elements.filter((element): element is Record<string, unknown> =>
        typeof element === "object" && element !== null && !Array.isArray(element),
      )
    : [];

  const canvasState = previewState?.canvas && typeof previewState.canvas === "object"
    ? previewState.canvas as Record<string, unknown>
    : {};
  const canvasMode = canvasState.mode === "fixed" ? "fixed" : "responsive";
  const snapEnabled = canvasState.snap !== false;
  const snapSize = previewPercent(canvasState.snapSize, 2, 1, canvasMode === "fixed" ? 500 : 25);
  const canvasWidth = previewPercent(canvasState.width, 1920, 320, 7680);
  const canvasHeight = previewPercent(canvasState.height, 1080, 180, 4320);

  function writeDocument(elements: Record<string, unknown>[], canvas = canvasState) {
    if (!previewState) return;
    setDraftText(JSON.stringify({ ...previewState, version: 1, canvas, elements }, null, 2));
  }

  function writeElements(elements: Record<string, unknown>[]) {
    writeDocument(elements);
  }

  function updateCanvas(patch: Record<string, unknown>) {
    const nextCanvas = { ...canvasState, ...patch };
    let nextElements = previewElements;
    if (patch.mode === "fixed" && canvasMode !== "fixed") {
      nextElements = previewElements.map((element) => ({
        ...element,
        x: previewPercent(element.x, 5, 0, 100) * canvasWidth / 100,
        y: previewPercent(element.y, 5, 0, 100) * canvasHeight / 100,
        width: previewPercent(element.width, 42, 1, 100) * canvasWidth / 100,
        height: previewPercent(element.height, 18, 1, 100) * canvasHeight / 100,
      }));
    } else if (patch.mode === "responsive" && canvasMode === "fixed") {
      nextElements = previewElements.map((element) => ({
        ...element,
        x: previewPercent(element.x, 5, 0, canvasWidth) * 100 / canvasWidth,
        y: previewPercent(element.y, 5, 0, canvasHeight) * 100 / canvasHeight,
        width: previewPercent(element.width, 42, 1, canvasWidth) * 100 / canvasWidth,
        height: previewPercent(element.height, 18, 1, canvasHeight) * 100 / canvasHeight,
      }));
    }
    writeDocument(nextElements, nextCanvas);
  }

  function snapValue(value: number) {
    return snapEnabled ? Math.round(value / snapSize) * snapSize : value;
  }

  function startComponentDrag(event: React.PointerEvent<HTMLElement>, index: number, element: Record<string, unknown>, mode: "move" | "resize" = "move") {
    if (element.locked === true || !previewStage.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      index,
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      x: previewPercent(element.x, 5, 0, canvasMode === "fixed" ? canvasWidth : 100),
      y: previewPercent(element.y, 5, 0, canvasMode === "fixed" ? canvasHeight : 100),
      width: previewPercent(element.width, canvasMode === "fixed" ? 42 * canvasWidth / 100 : 42, 1, canvasMode === "fixed" ? canvasWidth : 100),
      height: previewPercent(element.height, canvasMode === "fixed" ? 18 * canvasHeight / 100 : 18, 1, canvasMode === "fixed" ? canvasHeight : 100),
    };
  }

  function moveComponentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    const stage = previewStage.current;
    if (!drag || drag.pointerId !== event.pointerId || !stage) return;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const dx = ((event.clientX - drag.startX) / bounds.width) * (canvasMode === "fixed" ? canvasWidth : 100);
    const dy = ((event.clientY - drag.startY) / bounds.height) * (canvasMode === "fixed" ? canvasHeight : 100);
    const element = previewElements[drag.index];
    if (!element || element.locked === true) return;
    const maxX = canvasMode === "fixed" ? canvasWidth : 100;
    const maxY = canvasMode === "fixed" ? canvasHeight : 100;
    if (drag.mode === "resize") {
      updateComponent(drag.index, {
        width: Math.min(maxX - drag.x, Math.max(1, snapValue(drag.width + dx))),
        height: Math.min(maxY - drag.y, Math.max(1, snapValue(drag.height + dy))),
      });
      return;
    }
    updateComponent(drag.index, {
      x: Math.min(maxX - drag.width, Math.max(0, snapValue(drag.x + dx))),
      y: Math.min(maxY - drag.height, Math.max(0, snapValue(drag.y + dy))),
    });
  }

  function endComponentDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null;
  }

  function addComponent(type: ComponentType) {
    const defaults: Record<ComponentType, string> = {
      "now-playing": "Now Playing",
      "request-queue": "Request Queue",
      "recent-tracks": "Recently Played",
      announcement: "Your announcement goes here",
      "custom-text": "Edit this text",
      "custom-image": "https://example.com/image.png",
      background: "Background",
      decoration: "Decoration",
    };
    writeElements([...previewElements, {
      id: crypto.randomUUID(),
      type,
      name: COMPONENT_LIBRARY.find((item) => item.type === type)?.label ?? type,
      text: defaults[type],
      x: (5 + (previewElements.length % 3) * 5) * (canvasMode === "fixed" ? canvasWidth / 100 : 1),
      y: (5 + (previewElements.length % 4) * 5) * (canvasMode === "fixed" ? canvasHeight / 100 : 1),
      width: (type === "background" ? 90 : 42) * (canvasMode === "fixed" ? canvasWidth / 100 : 1),
      height: (type === "now-playing" ? 24 : 18) * (canvasMode === "fixed" ? canvasHeight / 100 : 1),
      locked: false,
    }]);
  }

  function updateComponent(index: number, patch: Record<string, unknown>) {
    writeElements(previewElements.map((element, elementIndex) =>
      elementIndex === index ? { ...element, ...patch } : element,
    ));
  }

  function removeComponent(index: number) {
    writeElements(previewElements.filter((_, elementIndex) => elementIndex !== index));
  }

  async function saveDraft() {
    if (!editor || !workspaceId || !previewState) {
      setError("Fix the JSON document before saving the draft.");
      return;
    }
    setEditorBusy(true);
    setError("");
    try {
      const saved = await request<{ draftState: Record<string, unknown>; draftRevision: number; updatedAt: string }>(
        `/workspaces/${workspaceId}/scenes/${editor.sceneId}/draft`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: previewState, expectedRevision: editor.draftRevision }),
        },
      );
      setEditor({ ...editor, draftState: saved.draftState, draftRevision: saved.draftRevision, updatedAt: saved.updatedAt });
      setDraftText(JSON.stringify(saved.draftState, null, 2));
      setMessage("Draft saved. The OBS overlay remains on its previously published state.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the draft.");
    } finally {
      setEditorBusy(false);
    }
  }

  async function publishDraft() {
    if (!editor || !workspaceId || !previewState) {
      setError("Save a valid draft before publishing.");
      return;
    }
    if (JSON.stringify(previewState) !== JSON.stringify(editor.draftState)) {
      setError("Save your latest draft changes before publishing.");
      return;
    }
    setEditorBusy(true);
    setError("");
    try {
      const saved = await request<{ publishedAt: string; publishedRevision: number }>(
        `/workspaces/${workspaceId}/scenes/${editor.sceneId}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: editor.draftRevision }),
        },
      );
      setEditor({ ...editor, publishedAt: saved.publishedAt, hasPublishedState: true });
      setMessage("Draft published. Connected OBS overlays will reload the published scene.");
      await loadScenes();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not publish the scene.");
    } finally {
      setEditorBusy(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("OBS browser-source URL copied.");
    } catch {
      setMessage("Clipboard access was unavailable. Select and copy the URL shown below.");
    }
  }

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/">♫ Streamer Audio</a>
      <nav className="page-nav"><a href="/">Dashboard</a><a href="/team">Team</a><a href="/notifications">Notifications</a><a href="/settings">Settings</a></nav>
    </header>
    <section className="welcome">
      <div><p className="eyebrow">HOSTED OBS OVERLAYS</p><h1>Scenes</h1><p className="subheading">Each scene has its own stable path and independently revocable read-only access token. Set NEXT_PUBLIC_OVERLAY_BASE_URL to the hosted overlay origin when it is deployed separately.</p></div>
    </section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    {loading ? <div className="panel">Loading workspaces…</div> : <>
      <div className="scene-toolbar">
        <label>WORKSPACE<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setSecrets([]); }}>
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </select></label>
      </div>
      {canManage && <section className="panel team-panel">
        <div className="panel-heading"><div><p className="eyebrow">NEW SCENE</p><h2>Create an OBS scene</h2></div></div>
        <form className="scene-create" onSubmit={(event) => void createScene(event)}>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Scene name" aria-label="Scene name" required />
          <button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? "Working…" : "Create scene"}</button>
        </form>
      </section>}
      <section className="panel team-panel">
        <div className="panel-heading"><div><p className="eyebrow">WORKSPACE SCENES</p><h2>Overlay access</h2></div><button type="button" className="secondary-button" disabled={busy} onClick={() => void loadScenes()}>Refresh</button></div>
        {scenes.length ? <div className="scene-list">{scenes.map((scene) => {
          const secret = secrets.find((item) => item.sceneId === scene.id);
          return <article className="scene-row" key={scene.id}>
            <div className="scene-row-main">
              <strong>{scene.name}</strong>
              <span className={scene.has_active_access ? "scene-status is-active" : "scene-status is-revoked"}>{scene.has_active_access ? "Access active" : "Access revoked"}</span>
              <small>Stable scene path: /scene/{scene.id}</small>
              {secret && <div className="scene-secret">
                <strong>New OBS browser-source URL</strong>
                <p>This secret is held only in this page until you leave or refresh. Copy it into OBS now. It is not stored in plaintext by the platform.</p>
                <input aria-label={`OBS URL for ${scene.name}`} readOnly value={secret.url} onFocus={(event) => event.currentTarget.select()} />
                <div className="scene-secret-actions"><button type="button" className="secondary-button" onClick={() => void copyUrl(secret.url)}>Copy OBS URL</button></div>
              </div>}
            </div>
            {canManage && <div className="scene-row-actions">
              <button type="button" className="secondary-button" disabled={busy || editorBusy} onClick={() => void openEditor(scene)}>Edit scene</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void rotateToken(scene)}>Issue new token</button>
              {scene.has_active_access && <button type="button" className="text-button danger-text" disabled={busy} onClick={() => void revokeToken(scene)}>Revoke access</button>}
            </div>}
          </article>;
        })}</div> : <div className="quiet-empty"><span>♫</span><p>No scenes have been created for this workspace.</p><small>Create a scene to issue its first OBS access URL.</small></div>}
      </section>
      
      {editor && <section className="panel team-panel scene-editor-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">SCENE EDITOR</p><h2>{editor.name}</h2><small>Draft revision {editor.draftRevision} · {editor.hasPublishedState ? "A published version is live" : "Nothing published yet"}</small></div>
          <button type="button" className="secondary-button" onClick={() => setEditor(null)}>Close editor</button>
        </div>
        <div className="scene-editor-grid">
          <div className="scene-draft-column">
            <div className="component-library">
              <strong>Component library</strong>
              <p>Add an element to this scene, then edit its content and placement.</p>
              <div className="component-library-grid">
                {COMPONENT_LIBRARY.map((component) => <button
                  type="button"
                  className="component-library-item"
                  key={component.type}
                  onClick={() => addComponent(component.type)}
                  disabled={!previewState || editorBusy}
                >
                  <strong>{component.label}</strong><small>{component.description}</small>
                </button>)}
              </div>
            </div>
            <div className="component-list">
              <strong>Scene components ({previewElements.length})</strong>
              {previewElements.length === 0 && <p className="component-empty">This scene is empty. Add a component from the library above.</p>}
              {previewElements.map((element, index) => <fieldset className="component-settings" key={typeof element.id === "string" ? element.id : index}>
                <legend>{typeof element.name === "string" ? element.name : String(element.type ?? "Component")}</legend>
                <label>Content
                  <input value={typeof element.text === "string" ? element.text : ""} onChange={(event) => updateComponent(index, { text: event.target.value })} />
                </label>
                {element.type === "custom-image" && <label>Image URL
                  <input value={typeof element.src === "string" ? element.src : ""} placeholder="https://…" onChange={(event) => updateComponent(index, { src: event.target.value })} />
                </label>}
                <div className="component-number-grid">
                  {(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{key.toUpperCase()} ({canvasMode === "fixed" ? "px" : "%"})
                    <input type="number" min={key === "width" || key === "height" ? 1 : 0} max={canvasMode === "fixed" ? (key === "x" || key === "width" ? canvasWidth : canvasHeight) : 100} disabled={element.locked === true} value={previewPercent(element[key], key === "width" ? 42 : key === "height" ? 18 : 5, 0, key === "x" || key === "width" ? (canvasMode === "fixed" ? canvasWidth : 100) : (canvasMode === "fixed" ? canvasHeight : 100))} onChange={(event) => {
                      const value = Number(event.target.value);
                      const maxWidth = canvasMode === "fixed" ? canvasWidth : 100;
                      const maxHeight = canvasMode === "fixed" ? canvasHeight : 100;
                      const maximum = key === "x" ? maxWidth - previewPercent(element.width, 42, 1, maxWidth) : key === "y" ? maxHeight - previewPercent(element.height, 18, 1, maxHeight) : key === "width" ? maxWidth - previewPercent(element.x, 5, 0, maxWidth) : maxHeight - previewPercent(element.y, 5, 0, maxHeight);
                      updateComponent(index, { [key]: Math.min(maximum, Math.max(key === "width" || key === "height" ? 1 : 0, snapValue(value))) });
                    }} />
                  </label>)}
                </div>
                <label className="component-lock-control"><input type="checkbox" checked={element.locked === true} onChange={(event) => updateComponent(index, { locked: event.target.checked })} /> Lock position and size</label>
                <button type="button" className="text-button danger-text" onClick={() => removeComponent(index)}>Remove component</button>
              </fieldset>)}
            </div>
            <div className="scene-editor-actions">
              <button type="button" className="secondary-button" disabled={editorBusy || !previewState} onClick={() => void saveDraft()}>{editorBusy ? "Working…" : "Save draft"}</button>
              <button type="button" className="primary-button" disabled={editorBusy || !previewState} onClick={() => void publishDraft()}>Publish draft</button>
            </div>
            <small>Saving changes only the private draft. Publishing is a separate, explicit action. Component content is stored in the scene draft until published.</small>
          </div>
          <div className="scene-preview-column">
            <div className="scene-preview-heading"><strong>Live draft preview</strong><span>LOCAL · UNSAVED CHANGES</span></div>
            <div className="scene-layout-toolbar">
              <label>Canvas mode<select value={canvasMode} onChange={(event) => updateCanvas({ mode: event.target.value })}><option value="responsive">Responsive (%)</option><option value="fixed">Fixed pixels</option></select></label>
              {canvasMode === "fixed" && <>
                <label>Width (px)<input type="number" min="320" max="7680" value={canvasWidth} onChange={(event) => updateCanvas({ width: previewPercent(Number(event.target.value), 1920, 320, 7680) })} /></label>
                <label>Height (px)<input type="number" min="180" max="4320" value={canvasHeight} onChange={(event) => updateCanvas({ height: previewPercent(Number(event.target.value), 1080, 180, 4320) })} /></label>
              </>}
              <label className="snap-toggle"><input type="checkbox" checked={snapEnabled} onChange={(event) => updateCanvas({ snap: event.target.checked })} /> Snap to guides</label>
              <label>Grid ({canvasMode === "fixed" ? "px" : "%"})<input type="number" min="1" max={canvasMode === "fixed" ? 500 : 25} value={snapSize} onChange={(event) => updateCanvas({ snapSize: previewPercent(Number(event.target.value), 2, 1, canvasMode === "fixed" ? 500 : 25) })} /></label>
            </div>
            <div className="scene-preview-canvas">
              <div
                ref={previewStage}
                className={`scene-preview-stage ${snapEnabled ? "has-layout-guides" : ""} ${canvasMode === "fixed" ? "is-fixed-canvas" : ""}`}
                style={{
                  ...(canvasMode === "fixed" ? { width: `${canvasWidth}px`, height: `${canvasHeight}px`, aspectRatio: "auto" } : {}),
                  ...(snapEnabled ? { backgroundSize: canvasMode === "fixed" ? `${snapSize}px ${snapSize}px` : `${snapSize}% ${snapSize}%` } : {}),
                }}
                onPointerMove={moveComponentDrag}
                onPointerUp={endComponentDrag}
                onPointerCancel={endComponentDrag}
              >
                {previewElements.map((element, index) => {
                  const left = previewPercent(element.x, 5 + (index % 3) * 30, 0, canvasMode === "fixed" ? canvasWidth : 99);
                  const top = previewPercent(element.y, 8 + Math.floor(index / 3) * 28, 0, canvasMode === "fixed" ? canvasHeight : 99);
                  const width = previewPercent(element.width, canvasMode === "fixed" ? 28 * canvasWidth / 100 : 28, 1, (canvasMode === "fixed" ? canvasWidth : 100) - left);
                  const height = previewPercent(element.height, canvasMode === "fixed" ? 18 * canvasHeight / 100 : 18, 1, (canvasMode === "fixed" ? canvasHeight : 100) - top);
                  const label = typeof element.text === "string"
                    ? element.text
                    : typeof element.name === "string"
                      ? element.name
                      : "Preview element";
                  return <div
                    className={`scene-preview-element scene-preview-${typeof element.type === "string" ? element.type : "component"}`}
                    key={typeof element.id === "string" ? element.id : index}
                    style={{ left: `${left}${canvasMode === "fixed" ? "px" : "%"}`, top: `${top}${canvasMode === "fixed" ? "px" : "%"}`, width: `${width}${canvasMode === "fixed" ? "px" : "%"}`, height: `${height}${canvasMode === "fixed" ? "px" : "%"}`, cursor: element.locked === true ? "not-allowed" : "move", touchAction: "none", outline: element.locked === true ? "1px solid #d7b56d" : undefined }}
                    onPointerDown={(event) => startComponentDrag(event, index, element)}
                  >
                    <small>{typeof element.type === "string" ? element.type.replaceAll("-", " ") : "Component"}{element.locked === true ? " · locked" : ""}</small>
                    <span>{label}</span>
                    {element.locked !== true && <i
                      className="scene-preview-resize"
                      role="presentation"
                      onPointerDown={(event) => startComponentDrag(event, index, element, "resize")}
                    />}
                  </div>;
                })}
                {previewElements.length === 0 && <div className="scene-preview-empty">Empty scene · add components in the next editor milestone</div>}
              </div>
            </div>
            <small>Preview reflects the editor buffer immediately. It is not served to OBS until you publish.</small>
          </div>
        </div>
      </section>}

    </>}
    <footer className="footer"><span>Hosted overlay scenes</span><a href="/">Back to dashboard</a></footer>
  </main>;
}
