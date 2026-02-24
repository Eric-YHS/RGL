import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// Keep only runtime-required files under dist/{hdri,textures,models}.
// This trims unused public assets from production builds without changing render quality.
const DIST_STATIC_KEEP = new Set<string>([
  "hdri/daytime.hdr",
  "textures/polyhaven/asphalt_05/asphalt_05_diff_1k.jpg",
  "textures/polyhaven/asphalt_05/asphalt_05_nor_gl_1k.png",
  "textures/polyhaven/asphalt_05/asphalt_05_arm_1k.jpg",
  "textures/polyhaven/concrete_pavement/concrete_pavement_diff_1k.jpg",
  "textures/polyhaven/concrete_pavement/concrete_pavement_nor_gl_1k.png",
  "textures/polyhaven/concrete_pavement/concrete_pavement_arm_1k.jpg",
  "textures/polyhaven/concrete_tile_facade/concrete_tile_facade_diff_1k.jpg",
  "textures/polyhaven/concrete_tile_facade/concrete_tile_facade_nor_gl_1k.png",
  "textures/polyhaven/concrete_tile_facade/concrete_tile_facade_arm_1k.jpg",
  // Optional overrides referenced at runtime.
  "textures/wallpaper.jpg",
  "textures/wallpaper.png",
]);

const DIST_PRUNE_ROOTS = ["hdri", "textures", "models"] as const;

function pruneUnusedDistStaticAssets(): Plugin {
  return {
    name: "prune-unused-dist-static-assets",
    apply: "build",
    async closeBundle() {
      const distRoot = path.resolve(process.cwd(), "dist");

      for (const root of DIST_PRUNE_ROOTS) {
        const rootAbs = path.join(distRoot, root);
        if (!(await pathExists(rootAbs))) continue;
        await pruneDirByKeepSet(rootAbs, root, DIST_STATIC_KEEP);
        await removeDirIfEmpty(rootAbs);
      }
    },
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function hasKeepDescendant(relPrefix: string, keepSet: ReadonlySet<string>): boolean {
  if (keepSet.has(relPrefix)) return true;
  const prefix = `${relPrefix}/`;
  for (const p of keepSet) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

async function removeDirIfEmpty(absDir: string): Promise<void> {
  if (!(await pathExists(absDir))) return;
  const remain = await readdir(absDir);
  if (remain.length === 0) {
    await rm(absDir, { recursive: true, force: true });
  }
}

async function pruneDirByKeepSet(
  absDir: string,
  relDir: string,
  keepSet: ReadonlySet<string>
): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = `${relDir}/${entry.name}`;
    const absPath = path.join(absDir, entry.name);

    if (entry.isDirectory()) {
      if (!hasKeepDescendant(relPath, keepSet)) {
        await rm(absPath, { recursive: true, force: true });
        continue;
      }
      await pruneDirByKeepSet(absPath, relPath, keepSet);
      await removeDirIfEmpty(absPath);
      continue;
    }

    if (!keepSet.has(relPath)) {
      await rm(absPath, { force: true });
    }
  }
}

export default defineConfig({
  plugins: [pruneUnusedDistStaticAssets()],
  server: {
    // Allow temporary tunnel hostnames (e.g. localhost.run) during external testing.
    allowedHosts: true,
    // In local development, proxy API requests to the backend service.
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_TARGET ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
