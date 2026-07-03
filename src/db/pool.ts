import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const q = <T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
) => pool.query<T>(text, params);
