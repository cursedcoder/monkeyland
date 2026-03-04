import { invoke } from "@tauri-apps/api/core";
import type { SessionLayout, BeadsTask } from "./types";

export enum ProjectState {
  NEW = "NEW",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR",
}

export interface InspectionResult {
  state: ProjectState;
  projectPath: string | null;
  completedEpics: BeadsTask[];
  activeEpics: BeadsTask[];
  remainingTasks: BeadsTask[];
  zombiesArchived: string[];
  errorMessage?: string;
  /** Pre-built context string to append to the WM system prompt. */
  stateContext: string;
  /** Human-readable summary for the COMPLETED short-circuit message. */
  completionSummary?: string;
}

const isClosed = (t: BeadsTask) => t.status === "done" || t.status === "closed";
const isEpic = (t: BeadsTask) => t.type === "epic" || t.issue_type === "epic";

function detectProjectPath(layouts: SessionLayout[]): string | null {
  for (const card of layouts) {
    if (card.node_type !== "beads") continue;
    try {
      const p = JSON.parse(card.payload ?? "{}");
      if (p.beadsStatus?.projectPath) return p.beadsStatus.projectPath;
    } catch { /* ignore */ }
  }
  return null;
}

export function getActiveTaskIds(layouts: SessionLayout[]): Set<string> {
  const ids = new Set<string>();
  for (const l of layouts) {
    try {
      const p = JSON.parse(l.payload ?? "{}");
      if (p.task_id && p.status === "loading") ids.add(p.task_id);
    } catch { /* ignore */ }
  }
  return ids;
}

/**
 * Core inspection logic against a known project path.
 * Caller MUST ensure Dolt is already running for this project.
 *
 * 1. Lists all tasks
 * 2. Archives zombie/duplicate epics and their children
 * 3. Classifies state as NEW / IN_PROGRESS / COMPLETED / ERROR
 * 4. Builds prompt context and completion summary
 */
export async function inspectExistingProject(
  projectPath: string,
  activeTaskIds: Set<string>,
): Promise<InspectionResult> {
  let allTasks: BeadsTask[];
  try {
    const raw = await invoke<string>("beads_run", {
      projectPath,
      args: ["list", "--json", "--all"],
      agentId: null,
    });
    const parsed = JSON.parse(raw.trim());
    allTasks = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[inspection] beads_run list failed:", msg);
    return {
      state: ProjectState.ERROR,
      projectPath,
      completedEpics: [],
      activeEpics: [],
      remainingTasks: [],
      zombiesArchived: [],
      errorMessage: `Could not list tasks for ${projectPath}: ${msg}`,
      stateContext: "",
    };
  }

  if (allTasks.length === 0) {
    console.log("[inspection] Project exists but has no tasks — treating as NEW");
    return {
      state: ProjectState.NEW,
      projectPath,
      completedEpics: [],
      activeEpics: [],
      remainingTasks: [],
      zombiesArchived: [],
      stateContext: "",
    };
  }

  console.log(`[inspection] Found ${allTasks.length} tasks in ${projectPath}`);

  // --- Zombie detection and cleanup ---
  const toArchive = new Set<string>();
  const cleanupNotes: string[] = [];

  const epics = allTasks.filter(isEpic);
  const closedEpics = epics.filter(isClosed);
  const openEpics = epics.filter(e => !isClosed(e));

  if (closedEpics.length > 0) {
    for (const ep of openEpics) {
      if (!activeTaskIds.has(ep.id)) {
        toArchive.add(ep.id);
        cleanupNotes.push(
          `Archived zombie epic "${ep.title}" (${ep.id}) — completed epic ${closedEpics[0].id} exists`,
        );
      }
    }
  } else if (openEpics.length > 1) {
    const sorted = [...openEpics].sort((a, b) => {
      if (activeTaskIds.has(a.id) && !activeTaskIds.has(b.id)) return -1;
      if (!activeTaskIds.has(a.id) && activeTaskIds.has(b.id)) return 1;
      const aT = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bT = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bT - aT;
    });
    const keeper = sorted[0];
    for (const ep of sorted.slice(1)) {
      if (!activeTaskIds.has(ep.id)) {
        toArchive.add(ep.id);
        cleanupNotes.push(
          `Archived duplicate epic "${ep.title}" (${ep.id}) — keeping ${keeper.id}`,
        );
      }
    }
  }

  // Cascade: archive children of archived epics
  let frontier = new Set(toArchive);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const t of allTasks) {
      if (toArchive.has(t.id)) continue;
      const pid = t.parent || t.parent_id;
      if (pid && frontier.has(pid) && !activeTaskIds.has(t.id)) {
        toArchive.add(t.id);
        next.add(t.id);
      }
    }
    frontier = next;
  }

  // Title-based dedup for surviving non-epic tasks
  const surviving = allTasks.filter(t => !toArchive.has(t.id) && !isEpic(t));
  const groups = new Map<string, BeadsTask[]>();
  for (const t of surviving) {
    const key = `${t.type || t.issue_type}:${(t.title || "").trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => {
      if (isClosed(a) && !isClosed(b)) return -1;
      if (!isClosed(a) && isClosed(b)) return 1;
      if (activeTaskIds.has(a.id) && !activeTaskIds.has(b.id)) return -1;
      if (!activeTaskIds.has(a.id) && activeTaskIds.has(b.id)) return 1;
      const aT = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bT = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bT - aT;
    });
    const winner = group[0];
    for (const loser of group.slice(1)) {
      if (!activeTaskIds.has(loser.id)) {
        toArchive.add(loser.id);
        cleanupNotes.push(
          `Archived duplicate task "${loser.title}" (${loser.id}) — keeping ${winner.id}`,
        );
      }
    }
  }

  // Perform archiving
  const archived: string[] = [];
  if (toArchive.size > 0) {
    console.log(`[inspection] Archiving ${toArchive.size} zombie/duplicate tasks: ${[...toArchive].join(", ")}`);
    for (const id of toArchive) {
      try {
        await invoke("beads_run", {
          projectPath,
          args: ["close", id, "--reason", "Auto-closed: zombie/duplicate detected by inspection"],
          agentId: null,
        });
        archived.push(id);
      } catch (e) {
        console.warn(`[inspection] Failed to archive ${id}:`, e);
      }
    }
  }

  // --- Classify state ---
  const remaining = allTasks.filter(t => !toArchive.has(t.id));
  const remainingEpics = remaining.filter(isEpic);
  const finalClosedEpics = remainingEpics.filter(isClosed);
  const finalOpenEpics = remainingEpics.filter(e => !isClosed(e));

  let state: ProjectState;
  if (finalClosedEpics.length > 0 && finalOpenEpics.length === 0) {
    state = ProjectState.COMPLETED;
  } else if (finalOpenEpics.length > 0) {
    state = ProjectState.IN_PROGRESS;
  } else if (remaining.length > 0) {
    state = ProjectState.IN_PROGRESS;
  } else {
    state = ProjectState.NEW;
  }

  console.log(`[inspection] State: ${state} (${remaining.length} tasks remaining, ${archived.length} archived)`);

  // --- Build state context for the system prompt ---
  const ctxLines: string[] = [
    "",
    "## Current Project State (auto-detected — do NOT re-query with tools)",
    `Project path: ${projectPath}`,
    "",
  ];

  if (archived.length > 0) {
    ctxLines.push("### Auto-Cleanup Performed");
    ctxLines.push(`Archived ${archived.length} zombie/duplicate task(s):`);
    for (const n of cleanupNotes) ctxLines.push(`- ${n}`);
    ctxLines.push("");
  }

  if (remaining.length > 0) {
    ctxLines.push("### Existing Tasks");
    for (const t of remaining) {
      const type = t.type || t.issue_type || "task";
      const par = t.parent || t.parent_id;
      ctxLines.push(
        `- ${t.id} [${type}, ${t.status}]: "${t.title}"${par ? ` (parent: ${par})` : ""}`,
      );
    }
    ctxLines.push("");
  }

  if (state === ProjectState.COMPLETED) {
    ctxLines.push("### WORK IS ALREADY COMPLETED");
    ctxLines.push(
      `Epic ${finalClosedEpics[0].id} ("${finalClosedEpics[0].title}") is ${finalClosedEpics[0].status.toUpperCase()}.`,
    );
    ctxLines.push(
      "If the user wants modifications, create individual tasks (NOT epics) under the existing epic.",
    );
    ctxLines.push("");
  } else if (state === ProjectState.IN_PROGRESS && finalOpenEpics.length > 0) {
    ctxLines.push("### EPIC ALREADY IN PROGRESS");
    ctxLines.push(
      `Epic ${finalOpenEpics[0].id} ("${finalOpenEpics[0].title}") is ${finalOpenEpics[0].status}. Do NOT create another epic.`,
    );
    ctxLines.push(`Add tasks under it with parent_id: "${finalOpenEpics[0].id}".`);
    ctxLines.push("");
  }

  // --- Build completion summary ---
  let completionSummary: string | undefined;
  if (state === ProjectState.COMPLETED) {
    const epic = finalClosedEpics[0];
    const children = remaining.filter(t => {
      const pid = t.parent || t.parent_id;
      return pid === epic.id;
    });
    const taskLines = children.map(c => `- ${c.id}: ${c.title}`).join("\n");
    completionSummary = [
      `This project is already complete.`,
      ``,
      `**Project:** ${projectPath}`,
      `**Epic:** ${epic.title} (ID: ${epic.id})`,
      ``,
      children.length > 0
        ? `**Completed tasks:**\n${taskLines}`
        : `All work is finished.`,
      ``,
      `Would you like me to make any modifications?`,
    ].join("\n");
  }

  return {
    state,
    projectPath,
    completedEpics: finalClosedEpics,
    activeEpics: finalOpenEpics,
    remainingTasks: remaining,
    zombiesArchived: archived,
    stateContext: ctxLines.join("\n"),
    completionSummary,
  };
}

/**
 * Top-level inspection. Runs before the WM LLM turn.
 *
 * Detects project from canvas layouts, starts Dolt, and delegates to
 * inspectExistingProject for the heavy lifting.
 */
export async function inspectProject(layouts: SessionLayout[]): Promise<InspectionResult> {
  let projectPath = detectProjectPath(layouts);
  let fromMetaDb = false;

  // Fallback: if no beads card on canvas, check MetaDb for a previously stored project path
  if (!projectPath) {
    try {
      const stored = await invoke<string | null>("get_beads_project_path");
      if (stored) {
        projectPath = stored;
        fromMetaDb = true;
        console.log(`[inspection] No canvas card, but MetaDb has stored project: ${projectPath}`);
      }
    } catch {
      // MetaDb unavailable — proceed as NEW
    }
  }

  if (!projectPath) {
    console.log("[inspection] No beads card and no stored project — treating as NEW");
    return newResult(null);
  }

  console.log(`[inspection] Inspecting project: ${projectPath} (source: ${fromMetaDb ? "MetaDb" : "canvas"})`);

  // Dolt must be running — for MetaDb fallback, treat Dolt failure as NEW (stale path)
  try {
    await invoke("beads_dolt_start", { projectPath, agentId: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (fromMetaDb) {
      console.warn(`[inspection] MetaDb project path but Dolt failed — treating as NEW: ${msg}`);
      return newResult(null);
    }
    console.error("[inspection] Dolt failed to start:", msg);
    return {
      state: ProjectState.ERROR,
      projectPath,
      completedEpics: [],
      activeEpics: [],
      remainingTasks: [],
      zombiesArchived: [],
      errorMessage: `Could not start Dolt for project ${projectPath}: ${msg}`,
      stateContext: "",
    };
  }

  const activeTaskIds = getActiveTaskIds(layouts);
  return inspectExistingProject(projectPath, activeTaskIds);
}

function newResult(projectPath: string | null): InspectionResult {
  return {
    state: ProjectState.NEW,
    projectPath,
    completedEpics: [],
    activeEpics: [],
    remainingTasks: [],
    zombiesArchived: [],
    stateContext: "",
  };
}
