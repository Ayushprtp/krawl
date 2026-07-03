import { steelBaseUrl } from "../config.js";

export type SteelSession = {
  id: string;
  websocketUrl: string;
  sessionViewerUrl: string;
};

export const createSteelSession = async (
  index: number,
): Promise<SteelSession> => {
  const res = await fetch(`${steelBaseUrl(index)}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Steel session create failed (${res.status}).`);
  const data = (await res.json()) as SteelSession;
  if (!data?.websocketUrl) throw new Error("Steel session missing websocketUrl.");
  return data;
};

export const releaseSteelSession = async (index: number, id: string) => {
  try {
    await fetch(
      `${steelBaseUrl(index)}/v1/sessions/${encodeURIComponent(id)}/release`,
      { method: "POST", signal: AbortSignal.timeout(8000) },
    );
  } catch {
    /* best effort */
  }
};
