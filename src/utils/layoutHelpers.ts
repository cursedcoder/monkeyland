import type { SessionLayout } from "../types";
import { GRID_STEP } from "../types";

export const REPOSITION_ORIGIN = { x: 80, y: 80 };

/** Returns new layouts organized in a tree structure based on parent-child relationships. */
export function repositionLayouts(layouts: SessionLayout[]): SessionLayout[] {
  const childrenMap = new Map<string, string[]>();
  const roots: string[] = [];

  const nodeMap = new Map(layouts.map(l => [l.session_id, l]));

  for (const layout of layouts) {
    let parentId: string | undefined;
    if (layout.payload) {
      try {
        const p = JSON.parse(layout.payload) as {
          sourcePromptId?: string;
          parentAgentId?: string;
          parent_agent_id?: string;
          parentBeadsId?: string;
        };
        parentId = p.sourcePromptId ?? p.parentAgentId ?? p.parent_agent_id ?? p.parentBeadsId;
      } catch {
        /* ignore */
      }
    }

    if (parentId && nodeMap.has(parentId)) {
      if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
      childrenMap.get(parentId)!.push(layout.session_id);
    } else {
      roots.push(layout.session_id);
    }
  }

  roots.sort((a, b) => {
    const nodeA = nodeMap.get(a)!;
    const nodeB = nodeMap.get(b)!;
    if (nodeA.node_type === "prompt" && nodeB.node_type !== "prompt") return -1;
    if (nodeA.node_type !== "prompt" && nodeB.node_type === "prompt") return 1;
    return a.localeCompare(b);
  });

  const nextLayouts = [...layouts];

  function getRole(layout: SessionLayout): string {
    if (layout.payload) {
      try {
        const p = JSON.parse(layout.payload) as { role?: string };
        return p.role ?? "";
      } catch { return ""; }
    }
    return "";
  }

  function layoutSubtree(nodeId: string, startX: number, startY: number): { w: number, h: number } {
    const layoutIndex = nextLayouts.findIndex(l => l.session_id === nodeId);
    if (layoutIndex === -1) return { w: 0, h: 0 };

    const layout = nextLayouts[layoutIndex];
    const nodeW = layout.w;
    const nodeH = layout.collapsed ? 48 : layout.h;

    nextLayouts[layoutIndex] = { ...layout, x: startX, y: startY };

    const children = childrenMap.get(nodeId) || [];
    if (children.length === 0) {
      return { w: nodeW, h: nodeH };
    }

    children.sort((a, b) => {
      const na = nodeMap.get(a)!;
      const nb = nodeMap.get(b)!;
      const ra = getRole(na);
      const rb = getRole(nb);
      if (ra === "project_manager" && rb !== "project_manager") return -1;
      if (ra !== "project_manager" && rb === "project_manager") return 1;
      if (na.node_type === "beads" && nb.node_type !== "beads") return -1;
      if (na.node_type !== "beads" && nb.node_type === "beads") return 1;
      return a.localeCompare(b);
    });

    const role = getRole(layout);
    const isVertical = layout.node_type === "prompt" || role === "workforce_manager" || role === "project_manager";

    let subtreeW = nodeW;
    let subtreeH = nodeH;

    if (isVertical) {
      let currentY = startY;
      let maxChildW = 0;
      const childX = startX + nodeW + GRID_STEP;

      for (const childId of children) {
        const bbox = layoutSubtree(childId, childX, currentY);
        currentY += bbox.h + GRID_STEP;
        maxChildW = Math.max(maxChildW, bbox.w);
      }

      subtreeW = nodeW + GRID_STEP + maxChildW;
      subtreeH = Math.max(nodeH, currentY - startY - GRID_STEP);
    } else {
      let currentX = startX + nodeW + GRID_STEP;
      let maxChildH = 0;

      for (const childId of children) {
        const bbox = layoutSubtree(childId, currentX, startY);
        currentX += bbox.w + GRID_STEP;
        maxChildH = Math.max(maxChildH, bbox.h);
      }

      subtreeW = currentX - startX - GRID_STEP;
      subtreeH = Math.max(nodeH, maxChildH);
    }

    return { w: subtreeW, h: subtreeH };
  }

  let currentRootY = REPOSITION_ORIGIN.y;
  for (const rootId of roots) {
    const bbox = layoutSubtree(rootId, REPOSITION_ORIGIN.x, currentRootY);
    currentRootY += bbox.h + GRID_STEP * 2;
  }

  return nextLayouts;
}

/** Extract recent terminal command output from an agent's terminal log card. */
export function getTerminalDiagnostics(layouts: SessionLayout[], agentNodeId: string): string {
  const termLogLayout = layouts.find((l) => {
    if (l.node_type !== "terminal_log") return false;
    try {
      const p = JSON.parse(l.payload ?? "{}") as { parentAgentId?: string };
      return p.parentAgentId === agentNodeId;
    } catch { return false; }
  });
  if (!termLogLayout) return "";
  try {
    const p = JSON.parse(termLogLayout.payload ?? "{}") as {
      entries?: Array<{ command?: string; output?: string }>;
    };
    if (!p.entries?.length) return "";
    const recent = p.entries.slice(-5);
    return recent.map((e) => {
      const out = (e.output ?? "").slice(-500);
      return `$ ${e.command ?? "?"}\n${out}`;
    }).join("\n---\n");
  } catch { return ""; }
}

interface TaskMeta {
  title?: string;
  type?: string;
  priority?: number;
  description?: string;
}

/** Build a targeted nudge message by analyzing terminal output for common failure patterns. */
export function buildDiagnosticNudge(
  attempt: number,
  maxAttempts: number,
  userMessage: string,
  taskId: string | null,
  taskMeta: TaskMeta | undefined,
  projectPath: string | null | undefined,
  terminalDiag: string,
): string {
  const patterns: string[] = [];
  const lower = terminalDiag.toLowerCase();

  if (/y\/n|yes\/no|press enter|are you sure|confirm/i.test(terminalDiag)) {
    patterns.push("DETECTED: Interactive prompt requiring user input. Use --yes or -y flags to skip prompts.");
  }
  if (/eaddrinuse|address already in use|port.*already/i.test(terminalDiag)) {
    patterns.push("DETECTED: Port conflict. Kill the existing process or use a different port.");
  }
  if (/timed? ?out|timeout/i.test(lower)) {
    patterns.push("DETECTED: Command timed out. Use background execution: nohup cmd > /tmp/out.log 2>&1 &");
  }
  if (/listening on|started server|ready on|compiled|waiting for/i.test(lower) && !/exit/i.test(lower)) {
    patterns.push("DETECTED: A foreground server may be blocking. Run servers in background with nohup and &.");
  }
  if (/error|ERR!|ENOENT|not found|command not found|EACCES|permission denied/i.test(terminalDiag)) {
    patterns.push("DETECTED: Command errors in terminal output. Fix the errors before submitting.");
  }
  if (/npm warn|deprecated/i.test(lower) && patterns.length === 0) {
    patterns.push("NOTE: Warnings detected but no blocking errors. You can proceed to submit.");
  }

  const diagSection = patterns.length > 0
    ? `\n## Diagnosis from your terminal output\n${patterns.join("\n")}\n`
    : "";

  const terminalSection = terminalDiag
    ? `\n## Recent terminal output (last commands)\n\`\`\`\n${terminalDiag.slice(-1500)}\n\`\`\`\n`
    : "";

  const urgency = attempt >= maxAttempts
    ? "THIS IS YOUR FINAL ATTEMPT. If you do not call yield_for_review, your work will be auto-submitted without your summary."
    : `Attempt ${attempt}/${maxAttempts}. You must call yield_for_review when done.`;

  return [
    `# Self-Heal: Developer Task Recovery (attempt ${attempt}/${maxAttempts})`,
    "",
    urgency,
    "",
    "You are continuing the SAME developer task. Do NOT claim missing context or a fresh session.",
    diagSection,
    "## Your task",
    `- task_id: ${taskId ?? "unknown"}`,
    `- task_title: ${taskMeta?.title ?? "unknown"}`,
    `- project_path: ${projectPath ?? "unknown"}`,
    "",
    "Original assignment:",
    userMessage,
    terminalSection,
    "## What you must do NOW",
    "",
    "1. If there are errors or blocking issues in the terminal output above, FIX them:",
    "   - Interactive prompts → rerun with --yes flag",
    "   - Foreground servers → rerun with nohup in background",
    "   - Build/compile errors → fix the code and rebuild",
    "   - Port conflicts → kill the process or use a different port",
    "2. Once implementation is complete and verified, call `yield_for_review` with an accurate diff_summary.",
    "3. If implementation was already complete, just call `yield_for_review` immediately.",
  ].join("\n");
}
