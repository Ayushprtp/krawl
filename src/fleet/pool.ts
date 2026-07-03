import { config, steelBaseUrl } from "../config.js";
import { q } from "../db/pool.js";

export const fleetIndices = () =>
  Array.from({ length: config.fleet.size }, (_, i) => i);

export const isHealthy = async (index: number): Promise<boolean> => {
  try {
    const res = await fetch(`${steelBaseUrl(index)}/v1/sessions`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// A container is busy if it has a live session. Steel is 1-session-per-container,
// so allocation = pick a healthy container with no live session.
export const allocateContainer = async (): Promise<number> => {
  const busy = await q<{ container_idx: number }>(
    `SELECT container_idx FROM sessions WHERE status = 'live'`,
  );
  const busySet = new Set(busy.rows.map((r) => r.container_idx));
  for (const index of fleetIndices()) {
    if (busySet.has(index)) continue;
    if (await isHealthy(index)) return index;
  }
  throw new Error("No free browser container available (fleet at capacity).");
};

export const fleetHealth = async () => {
  let ok = 0;
  await Promise.all(
    fleetIndices().map(async (i) => {
      if (await isHealthy(i)) ok++;
    }),
  );
  return { healthy: ok, total: config.fleet.size };
};
