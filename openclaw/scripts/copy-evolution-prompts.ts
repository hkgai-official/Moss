#!/usr/bin/env tsx
/**
 * Copy evolution role prompts (src/evolution/prompts/*.md) into dist/prompts/
 * so the bundled prompt-loader.ts can resolve them at runtime.
 *
 * Why this script exists: tsdown bundles TS but leaves non-TS assets behind,
 * and prompt-loader.ts derives PROMPTS_DIR from the compiled JS location
 * (`dist/`). Without this copy step, a fresh `pnpm build` (and any Dockerfile
 * that runs it) produces an image where evolution stages throw at startup
 * with "Prompt template not found: /app/dist/prompts/<role>.md".
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcDir = path.join(projectRoot, "src", "evolution", "prompts");
const distDir = path.join(projectRoot, "dist", "prompts");

function copyEvolutionPrompts() {
  if (!fs.existsSync(srcDir)) {
    console.warn("[copy-evolution-prompts] Source directory not found:", srcDir);
    return;
  }

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const srcFile = path.join(srcDir, entry.name);
    const distFile = path.join(distDir, entry.name);
    fs.copyFileSync(srcFile, distFile);
    console.log(`[copy-evolution-prompts] Copied ${entry.name}`);
    copied++;
  }

  console.log(`[copy-evolution-prompts] Done (${copied} files)`);
}

copyEvolutionPrompts();
