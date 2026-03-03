#!/usr/bin/env node
/**
 * Validates that the frontend has no console errors or uncaught exceptions.
 * Uses Playwright to load the app with Tauri IPC mocked (window.__TAURI_VALIDATE__).
 * Agents can run: npm run validate:no-errors
 */

import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const PORT = 1421;

function killTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: rootDir,
      stdio: opts.silent ? "pipe" : "inherit",
      shell: true,
      ...opts,
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForPort(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) return true;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

async function runValidation() {
  const errors = [];
  let previewProc = null;

  try {
    await run("npm", ["run", "build"]);
    previewProc = spawn("npx", ["vite", "preview", "--port", String(PORT), "--host", "127.0.0.1"], {
      cwd: rootDir,
      stdio: "pipe",
      detached: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    previewProc.unref();
    await new Promise((r) => setTimeout(r, 1500));
    const ready = await waitForPort(20000);
    if (!ready) {
      errors.push({ kind: "script", text: "Preview server did not become ready" });
      killTree(previewProc);
      return errors;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") {
        errors.push({ kind: type, text: msg.text() });
      }
    });
    page.on("pageerror", (err) => {
      errors.push({ kind: "pageerror", text: err.message });
    });

    await page.addInitScript(() => {
      window.__TAURI_VALIDATE__ = true;
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, {
      waitUntil: "networkidle",
      timeout: 15000,
    });

    await page.waitForSelector("#root", { state: "attached", timeout: 5000 });
    await page.waitForTimeout(1500);

    await browser.close();
  } catch (e) {
    errors.push({ kind: "script", text: e.message });
  } finally {
    killTree(previewProc);
  }

  return errors;
}

runValidation().then((errors) => {
  if (errors.length > 0) {
    console.error("validate-no-console-errors: found errors:\n");
    errors.forEach(({ kind, text }) => console.error(`  [${kind}] ${text}`));
    process.exit(1);
  }
  console.log("validate-no-console-errors: no console/page errors.");
  process.exit(0);
});
