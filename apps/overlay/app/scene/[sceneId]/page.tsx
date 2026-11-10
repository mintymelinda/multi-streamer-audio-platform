export default async function OverlayScenePage({
  params,
}: {
  params: Promise<{ sceneId: string }>;
}) {
  const { sceneId } = await params;
  return (
    <main aria-label="Overlay scene">
      <p>Scene access is reserved. The authenticated read-only overlay runtime is being implemented next.</p>
      <code>{sceneId}</code>
    </main>
  );
}
