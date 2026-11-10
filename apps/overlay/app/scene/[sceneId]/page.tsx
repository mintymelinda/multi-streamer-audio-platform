import { OverlaySceneClient } from './overlay-scene-client.js';

export default async function OverlayScenePage({
  params,
}: {
  params: Promise<{ sceneId: string }>;
}) {
  const { sceneId } = await params;
  return <OverlaySceneClient sceneId={sceneId} />;
}
