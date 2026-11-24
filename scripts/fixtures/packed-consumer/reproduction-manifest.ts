import {
  decodeReproductionManifest,
  digestNodeCheckPlan,
  parseReproductionManifest,
  REPRODUCTION_MANIFEST_MAX_BYTES,
  type ReproductionManifest,
} from "tubeless/reproduction-manifest";

async function inspect(bytes: Uint8Array): Promise<ReproductionManifest> {
  if (bytes.length > REPRODUCTION_MANIFEST_MAX_BYTES) throw new Error("Manifest too large.");
  const manifest = await parseReproductionManifest(bytes);
  const digest = await digestNodeCheckPlan(manifest.nodeCheck.plan);
  return decodeReproductionManifest({ ...manifest, nodeCheck: { ...manifest.nodeCheck, digest } });
}
