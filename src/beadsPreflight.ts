import { invoke } from "@tauri-apps/api/core";
import type { SessionLayout } from "./types";

export interface PreflightResult {
  projectPath: string | null;
  stateContext: string;
  tasksArchived: number;
  workCompleted: boolean;
  completedEpicId: string | null;
}

/**
 * Runs BEFORE the LLM turn. Detects existing Beads projects on the canvas,
 * archives zombie/duplicate tasks, and builds a pre-computed state context
 * string to inject into the system prompt. This makes it impossible for the
 * LLM to skip state checks or sanitization.
 */
export async function runBeadsPreflight(layouts: SessionLayout[]): Promise<PreflightResult> {
  const result: PreflightResult = {
    projectPath: null,
    stateContext: "",
    tasksArchived: 0,
    workCompleted: false,
    completedEpicId: null,
  };

  const beadsCards = layouts.filter(l => l.node_type === "beads");
  if (beadsCards.length === 0) return result;

  let projectPath: string | null = null;
  for (const card of beadsCards) {
    try {
      const p = JSON.parse(card.payload ?? "{}");
      if (p.beadsStatus?.projectPath) {
        projectPath = p.beadsStatus.projectPath;
        break;
      }
    } catch { /* ignore */ }
  }
  if (!projectPath) return result;
  result.projectPath = projectPath;

  // Dolt must be running before beads_run works
  try {
    await invoke("beads_dolt_start", { projectPath, agentId: null });
  } catch (e) {
    console.warn("[preflight] Could not start Dolt, skipping preflight:", e);
    return result;
  }

  let tasks: any[];
  try {
    const listOutput = await invoke<string>("beads_run", {
      projectPath,
      args: ["list", "--json", "--all"],
      agentId: null,
    });
    tasks = JSON.parse(listOutput.trim());
    if (!Array.isArray(tasks)) return result;
  } catch (e) {
    console.warn("[preflight] beads_run failed:", e);
    return result;
  }

  if (tasks.length === 0) return result;

  // Identify tasks with currently-active agents on the canvas
  const activeTaskIds = new Set<string>();
  layouts.forEach(l => {
    try {
      const p = JSON.parse(l.payload ?? "{}");
      if (p.task_id && p.status === "loading") {
        activeTaskIds.add(p.task_id);
      }
    } catch { /* ignore */ }
  });

  const isClosed = (t: any) => t.status === "done" || t.status === "closed";
  const isEpic = (t: any) => t.type === "epic" || t.issue_type === "epic";

  const toArchive = new Set<string>();
  const cleanupSummaries: string[] = [];

  // --- Phase 1: Epic-level zombie detection ---
  // If a completed epic exists, ALL other non-active epics are zombies.
  // If no completed epic but multiple epics exist, keep the most recent
  // active one and archive the rest.
  const allEpics = tasks.filter(isEpic);
  const closedEpics = allEpics.filter(isClosed);
  const openEpics = allEpics.filter(e => !isClosed(e));

  if (closedEpics.length > 0) {
    // There's completed work. All non-closed, non-active epics are zombies.
    for (const ep of openEpics) {
      if (!activeTaskIds.has(ep.id)) {
        toArchive.add(ep.id);
        cleanupSummaries.push(
          `Zombie epic "${ep.title}" (${ep.id}, ${ep.status}) — project already has completed epic ${closedEpics[0].id}`,
        );
      }
    }
    result.workCompleted = true;
    result.completedEpicId = closedEpics[0].id;
  } else if (openEpics.length > 1) {
    // Multiple open epics, no completed one. Keep the most recently updated
    // active epic, archive the rest.
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
        cleanupSummaries.push(
          `Duplicate epic "${ep.title}" (${ep.id}) — keeping ${keeper.id}`,
        );
      }
    }
  }

  // --- Phase 2: Cascade — archive children of archived epics ---
  let frontier = new Set(toArchive);
  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const t of tasks) {
      if (toArchive.has(t.id)) continue;
      const pid = t.parent || t.parent_id;
      if (pid && frontier.has(pid) && !activeTaskIds.has(t.id)) {
        toArchive.add(t.id);
        next.add(t.id);
      }
    }
    frontier = next;
  }

  // --- Phase 3: Title-based deduplication for non-epic tasks ---
  const survivingTasks = tasks.filter(t => !toArchive.has(t.id) && !isEpic(t));
  const groups = new Map<string, any[]>();
  for (const t of survivingTasks) {
    const key = `${t.type || t.issue_type}:${(t.title || "").trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a: any, b: any) => {
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
      }
    }
    const archived = group.slice(1).filter((l: any) => toArchive.has(l.id));
    if (archived.length > 0) {
      cleanupSummaries.push(
        `Duplicate tasks "${group[0].title}": kept ${winner.id}, archived ${archived.map((l: any) => l.id).join(", ")}`,
      );
    }
  }

  // --- Phase 4: Perform archiving ---
  if (toArchive.size > 0) {
    console.log(`[preflight] Archiving ${toArchive.size} zombie/duplicate tasks: ${[...toArchive].join(", ")}`);
    for (const id of toArchive) {
      try {
        await invoke("beads_run", {
          projectPath,
          args: ["archive", id],
          agentId: null,
        });
      } catch (e) {
        console.warn(`[preflight] Failed to archive ${id}:`, e);
      }
    }
    result.tasksArchived = toArchive.size;
  }

  // --- Phase 5: Build state context for the system prompt ---
  const remaining = tasks.filter(t => !toArchive.has(t.id));
  const remainingEpics = remaining.filter(isEpic);
  const completedEpic = remainingEpics.find(isClosed);
  if (completedEpic) {
    result.workCompleted = true;
    result.completedEpicId = completedEpic.id;
  }

  const lines: string[] = [
    "",
    "## Current Project State (auto-detected — do NOT re-query with tools)",
    `Project path: ${projectPath}`,
    "",
  ];

  if (toArchive.size > 0) {
    lines.push("### Auto-Cleanup Performed");
    lines.push(`Archived ${toArchive.size} zombie/duplicate task(s) before your turn:`);
    for (const s of cleanupSummaries) lines.push(`- ${s}`);
    lines.push("");
  }

  if (remaining.length > 0) {
    lines.push("### Existing Tasks");
    for (const t of remaining) {
      const type = t.type || t.issue_type || "task";
      const par = t.parent || t.parent_id;
      lines.push(
        `- ${t.id} [${type}, ${t.status}]: "${t.title}"${par ? ` (parent: ${par})` : ""}`,
      );
    }
    lines.push("");
  }

  if (result.workCompleted && completedEpic) {
    lines.push("### WORK IS ALREADY COMPLETED");
    lines.push(
      `Epic ${completedEpic.id} ("${completedEpic.title}") is ${completedEpic.status.toUpperCase()}.`,
    );
    lines.push(
      "All subtasks are finished. DO NOT create a new epic or task. Inform the user the work is done and ask if they want modifications.",
    );
    lines.push("");
  } else if (remainingEpics.length > 0) {
    const openEpic = remainingEpics.find((e: any) => !isClosed(e));
    if (openEpic) {
      lines.push("### EPIC ALREADY IN PROGRESS");
      lines.push(
        `Epic ${openEpic.id} ("${openEpic.title}") is ${openEpic.status}. Do NOT create another epic.`,
      );
      lines.push(`Add new tasks under it with parent_id: "${openEpic.id}".`);
      lines.push("");
    }
  }

  result.stateContext = lines.join("\n");
  return result;
}
