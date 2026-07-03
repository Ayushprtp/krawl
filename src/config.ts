import "dotenv/config";

const num = (v: string | undefined, d: number) =>
  v && !Number.isNaN(Number(v)) ? Number(v) : d;

export const config = {
  port: num(process.env.PORT, 4000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:4000").replace(
    /\/+$/,
    "",
  ),

  fleet: {
    size: num(process.env.FLEET_SIZE, 25),
    portStart: num(process.env.FLEET_PORT_START, 3300),
    portEnd: num(process.env.FLEET_PORT_END, 3324),
    host: process.env.STEEL_HOST || "localhost",
    image:
      process.env.STEEL_IMAGE || "ghcr.io/steel-dev/steel-browser-api:latest",
    memCap: process.env.STEEL_MEM_CAP || "2g",
    cpuCap: process.env.STEEL_CPU_CAP || "2",
  },

  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://crawl:crawl_pw@localhost:5459/crawl",

  admin: {
    email: process.env.ADMIN_EMAIL || "admin@flare-labs.tech",
    passwordHash: process.env.ADMIN_PASSWORD_HASH || "",
    sessionSecret: process.env.SESSION_SECRET || "dev-insecure-secret",
  },

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || "https://api.flare-sh.tech/v1").replace(
      /\/+$/,
      "",
    ),
    apiKey: process.env.LLM_API_KEY || "",
    textModel:
      process.env.LLM_TEXT_MODEL ||
      "meta-llama/llama-4-scout-17b-16e-instruct",
    visionModel: process.env.LLM_VISION_MODEL || "",
    maxSteps: num(process.env.AGENT_MAX_STEPS, 10),
  },
};

// Host API port for a given fleet container index.
export const containerPort = (index: number) =>
  config.fleet.portStart + index;

export const steelBaseUrl = (index: number) =>
  `http://${config.fleet.host}:${containerPort(index)}`;
