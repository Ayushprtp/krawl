import { config } from "../config.js";
import type { Page } from "playwright";

type Action = {
  thought?: string;
  action: "navigate" | "click" | "type" | "press" | "scroll" | "wait" | "done";
  index?: number;
  url?: string;
  text?: string;
  summary?: string;
};

type StepLog = { n: number; label: string; mode: "dom" | "vision" };

const SYSTEM =
  'You control a real web browser. Reply with ONLY a JSON object: {"thought":"","action":"navigate|click|type|press|scroll|wait|done","index":0,"url":"","text":"","summary":""}. ' +
  "Use the element [index] for click/type. press sets text to a key (e.g. Enter). " +
  "Rules: after typing into a search box, the NEXT action must be press Enter (or click a suggestion) — never type the same thing twice. " +
  "Do not repeat the previous action; if a page didn't change, try a different element or press Enter. " +
  "When the task is complete or the info is gathered, use action 'done' with the answer in 'summary'. No prose, no code fences.";

const callLLM = async (
  model: string,
  userText: string,
  imageDataUrl?: string,
): Promise<Action> => {
  const content: any = imageDataUrl
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ]
    : userText;

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const j: any = await res.json();
  let raw: string = j?.choices?.[0]?.message?.content ?? "";
  if (typeof raw !== "string") raw = JSON.stringify(raw);
  raw = raw.replace(/```json|```/g, "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`LLM did not return JSON: ${raw.slice(0, 120)}`);
  return JSON.parse(m[0]) as Action;
};

const observe = async (page: Page) => {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const elements = await page
    .evaluate((max: number) => {
      const sel =
        "a[href],button,input,textarea,select,[role=button],[role=link],[onclick]";
      const nodes = Array.from(document.querySelectorAll(sel))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(el as HTMLElement);
          return (
            r.width > 0 &&
            r.height > 0 &&
            s.visibility !== "hidden" &&
            s.display !== "none"
          );
        })
        .slice(0, 45);
      return nodes.map((el, i) => {
        el.setAttribute("data-flare-idx", String(i));
        const he = el as HTMLElement;
        const name = (
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          he.innerText ||
          (el as HTMLInputElement).value ||
          el.getAttribute("name") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 70);
        return {
          i,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          name,
        };
      });
    }, 45)
    .catch(() => [] as { i: number; tag: string; type: string; name: string }[]);
  return { url, title, elements };
};

export const runAgent = async ({
  page,
  task,
  startUrl,
  maxSteps = config.llm.maxSteps,
  onStep,
}: {
  page: Page;
  task: string;
  startUrl?: string;
  maxSteps?: number;
  onStep?: (s: StepLog & { url: string }) => void;
}): Promise<{ summary: string; steps: StepLog[] }> => {
  const steps: StepLog[] = [];
  const history: string[] = [];
  let stuck = 0;
  let lastSig = "";
  let repeatNote = "";

  if (startUrl) {
    await page
      .goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
  }

  for (let n = 1; n <= maxSteps; n++) {
    const obs = await observe(page);
    const useVision =
      !!config.llm.visionModel && (obs.elements.length === 0 || stuck >= 2);
    const mode: "dom" | "vision" = useVision ? "vision" : "dom";

    const elementList = obs.elements
      .map(
        (e) => `[${e.i}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${e.name}`,
      )
      .join("\n");

    const userText = [
      `TASK: ${task}`,
      "",
      `PAGE: ${obs.title || "(untitled)"} — ${obs.url}`,
      useVision
        ? "A screenshot is attached. Identify targets visually; still use [index] from the list when possible."
        : "",
      "ELEMENTS:",
      elementList || "(none detected)",
      "",
      history.length ? `HISTORY:\n${history.slice(-8).join("\n")}` : "(no actions yet)",
      repeatNote,
      "",
      "Next action?",
    ]
      .filter(Boolean)
      .join("\n");

    let image: string | undefined;
    if (useVision) {
      const buf = await page
        .screenshot({ type: "jpeg", quality: 50 })
        .catch(() => null);
      if (buf) image = `data:image/jpeg;base64,${buf.toString("base64")}`;
    }

    let act: Action;
    try {
      act = await callLLM(
        useVision ? config.llm.visionModel : config.llm.textModel,
        userText,
        image,
      );
    } catch (e: any) {
      act = { action: "done", summary: `Stopped: ${e.message}` };
    }

    if (act.action === "done") {
      const summary =
        act.summary?.trim() || `Finished on ${obs.title || obs.url}.`;
      return { summary, steps };
    }

    // Anti-loop guard: if the model repeats the exact previous action, advance it.
    // A repeated `type` almost always means "now submit" -> press Enter.
    const sig = `${act.action}:${act.index ?? ""}:${act.text ?? ""}:${act.url ?? ""}`;
    if (sig === lastSig) {
      if (act.action === "type") {
        act = { action: "press", text: "Enter" };
      } else {
        stuck += 1; // force escalation (vision) and nudge the model
        repeatNote =
          "NOTE: you repeated the last action with no effect — choose a DIFFERENT element or action now.";
      }
    } else {
      repeatNote = "";
    }
    lastSig = `${act.action}:${act.index ?? ""}:${act.text ?? ""}:${act.url ?? ""}`;

    let ok = true;
    let label = act.action as string;
    try {
      switch (act.action) {
        case "navigate":
          await page.goto(act.url || "", {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
          label = `navigate -> ${act.url}`;
          break;
        case "click":
          await page.click(`[data-flare-idx="${act.index}"]`, { timeout: 8000 });
          await page
            .waitForLoadState("domcontentloaded", { timeout: 8000 })
            .catch(() => {});
          label = `click [${act.index}]`;
          break;
        case "type":
          await page.fill(`[data-flare-idx="${act.index}"]`, act.text || "", {
            timeout: 8000,
          });
          label = `type [${act.index}] "${(act.text || "").slice(0, 30)}"`;
          break;
        case "press":
          await page.keyboard.press(act.text || "Enter");
          await page
            .waitForLoadState("domcontentloaded", { timeout: 8000 })
            .catch(() => {});
          label = `press ${act.text || "Enter"}`;
          break;
        case "scroll":
          await page.mouse.wheel(0, 1200);
          label = "scroll";
          break;
        case "wait":
          await page.waitForTimeout(1500);
          label = "wait";
          break;
      }
    } catch (e: any) {
      ok = false;
      label = `${act.action} FAILED: ${String(e.message).slice(0, 50)}`;
    }

    stuck = ok ? 0 : stuck + 1;
    history.push(`${n}. ${label}`);
    steps.push({ n, label, mode });
    onStep?.({ n, label, mode, url: page.url() });
  }

  // Step limit reached without an explicit 'done'. Salvage a real answer by
  // reading the current page and asking the model to answer the task directly.
  const final = await observe(page);
  const pageText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 4000) || "")
    .catch(() => "");
  let answer = `Reached step limit (${maxSteps}). Last page: ${final.title || final.url}.`;
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.llm.textModel,
        temperature: 0,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `Task: ${task}\n\nCurrent page (${final.title} — ${final.url}):\n${pageText}\n\nAnswer the task concisely based on this page. If not answerable, say what was found.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j: any = await res.json();
    const c = j?.choices?.[0]?.message?.content;
    if (typeof c === "string" && c.trim()) answer = c.trim();
  } catch {
    /* keep default */
  }
  return { summary: answer, steps };
};

export { observe };
