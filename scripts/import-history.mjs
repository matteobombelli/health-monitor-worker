#!/usr/bin/env node

import { createInterface } from "node:readline";

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

console.log("PRAGMA defer_foreign_keys = true;");
for await (const line of input) {
  if (!line.trim()) continue;

  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }

  if (
    !Number.isInteger(row.run) ||
    !Number.isInteger(row.ts) ||
    typeof row.id !== "string" ||
    typeof row.label !== "string" ||
    typeof row.url !== "string"
  ) {
    continue;
  }

  const code = Number.parseInt(String(row.code), 10);
  const ms = Number.parseInt(String(row.ms), 10);
  if (!Number.isFinite(code) || !Number.isFinite(ms)) continue;

  console.log(
    `INSERT OR REPLACE INTO checks (run,ts,id,label,url,up,code,ms) VALUES (` +
      `${row.run},${row.ts},${sqlString(row.id)},${sqlString(row.label)},` +
      `${sqlString(row.url)},${row.up ? 1 : 0},${code},${ms});`,
  );
}
