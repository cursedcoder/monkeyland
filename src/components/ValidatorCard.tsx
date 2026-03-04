import React, { useCallback, useMemo, useRef, useState } from "react";
import type { SessionLayout } from "../types";
import { cardColorsFromId } from "../utils/cardColors";
import { snap } from "../utils/layoutHelpers";

interface CheckResult {
  status: "pending" | "pass" | "fail";
  reasons: string[];
  out_of_scope_files?: string[];
}

interface ValidationResults {
  code_review: CheckResult;
  business_logic: CheckResult;
  scope: CheckResult;
  visual?: CheckResult;
}

interface ValidatorPayload {
  role: string;
  status: "loading" | "done" | "error";
  parent_agent_id?: string;
  validationResults?: ValidationResults;
}

interface ValidatorCardProps {
  layout: SessionLayout;
  onLayoutChange: (layout: SessionLayout) => void;
  onLayoutCommit: (layout: SessionLayout) => void;
  onDragStart?: (nodeId: string, layout: SessionLayout) => void;
  onStop?: () => void;
  scale?: number;
}

const CHECK_LABELS: Record<string, string> = {
  code_review: "Code Review",
  business_logic: "Business Logic",
  scope: "Scope",
  visual: "Visual",
};

const CHECK_ORDER = ["code_review", "business_logic", "scope", "visual"] as const;

function StatusIcon({ status }: { status: "pending" | "pass" | "fail" }) {
  if (status === "pending") return <span className="validator-icon validator-icon--pending" />;
  if (status === "pass") return <span className="validator-icon validator-icon--pass">✓</span>;
  return <span className="validator-icon validator-icon--fail">✗</span>;
}

export const ValidatorCard = React.memo(function ValidatorCard({
  layout,
  onLayoutChange,
  onLayoutCommit,
  onDragStart,
  onStop,
  scale = 1,
}: ValidatorCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [liveLayout, setLiveLayout] = useState<SessionLayout | null>(null);
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardColors = useMemo(() => cardColorsFromId(layout.session_id), [layout.session_id]);
  const dragStart = useRef({ x: 0, y: 0, layoutX: 0, layoutY: 0 });
  const layoutRef = useRef(layout);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const onLayoutCommitRef = useRef(onLayoutCommit);
  layoutRef.current = layout;
  onLayoutChangeRef.current = onLayoutChange;
  onLayoutCommitRef.current = onLayoutCommit;
  const displayLayout = liveLayout ?? layout;

  const payload = useMemo<ValidatorPayload>(() => {
    if (!layout.payload) return { role: "validator", status: "loading" };
    try {
      return JSON.parse(layout.payload) as ValidatorPayload;
    } catch {
      return { role: "validator", status: "loading" };
    }
  }, [layout.payload]);

  const results = payload.validationResults;

  const handlePointerDownDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setLiveLayout(layout);
      setIsDragging(true);
      onDragStart?.(layout.session_id, layout);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        layoutX: layout.x,
        layoutY: layout.y,
      };
    },
    [layout, onDragStart],
  );

  const handlePointerMoveDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const dx = (e.clientX - dragStart.current.x) / scale;
      const dy = (e.clientY - dragStart.current.y) / scale;
      const newLayout = {
        ...layoutRef.current,
        x: snap(dragStart.current.layoutX + dx),
        y: snap(dragStart.current.layoutY + dy),
      };
      setLiveLayout(newLayout);
      onLayoutChangeRef.current(newLayout);
    },
    [isDragging, scale],
  );

  const handlePointerUpDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setIsDragging(false);
      const dx = (e.clientX - dragStart.current.x) / scale;
      const dy = (e.clientY - dragStart.current.y) / scale;
      const finalLayout = {
        ...layoutRef.current,
        x: snap(dragStart.current.layoutX + dx),
        y: snap(dragStart.current.layoutY + dy),
      };
      setLiveLayout(null);
      onLayoutCommitRef.current(finalLayout);
    },
    [isDragging, scale],
  );

  const allPassed = results
    ? CHECK_ORDER.every((k) => {
        const r = results[k as keyof ValidationResults];
        return !r || r.status === "pass";
      })
    : false;

  const anyFailed = results
    ? CHECK_ORDER.some((k) => {
        const r = results[k as keyof ValidationResults];
        return r?.status === "fail";
      })
    : false;

  const headerStatus = payload.status === "loading"
    ? "Validating..."
    : anyFailed
      ? "Failed"
      : allPassed
        ? "Passed"
        : "Done";

  return (
    <div
      ref={cardRef}
      className={`validator-card ${isDragging ? "dragging" : ""}`}
      style={{
        left: displayLayout.x,
        top: displayLayout.y,
        width: displayLayout.w,
        borderColor: cardColors.primary,
      }}
      onPointerDown={handlePointerDownDrag}
      onPointerMove={handlePointerMoveDrag}
      onPointerUp={handlePointerUpDrag}
    >
      <div className="validator-card__header">
        <span className="validator-card__title">Validation</span>
        <span className={`validator-card__status validator-card__status--${payload.status === "loading" ? "loading" : anyFailed ? "fail" : "pass"}`}>
          {headerStatus}
        </span>
        {onStop && payload.status === "loading" && (
          <button
            className="validator-card__stop"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            title="Stop"
          >
            ■
          </button>
        )}
      </div>
      <div className="validator-card__checks">
        {CHECK_ORDER.map((key) => {
          const check = results?.[key as keyof ValidationResults];
          if (!check) return null;
          const isExpanded = expandedCheck === key;
          const hasReasons = check.reasons.length > 0 && check.status === "fail";
          return (
            <React.Fragment key={key}>
              <div
                className={`validator-check-row validator-check-row--${check.status}${hasReasons ? " expandable" : ""}`}
                onClick={() => hasReasons && setExpandedCheck(isExpanded ? null : key)}
              >
                <StatusIcon status={check.status} />
                <span className="validator-check-label">{CHECK_LABELS[key] ?? key}</span>
                {hasReasons && (
                  <span className="validator-check-expand">{isExpanded ? "▾" : "▸"}</span>
                )}
              </div>
              {isExpanded && hasReasons && (
                <div className="validator-check-reasons">
                  {check.reasons.map((r, i) => (
                    <div key={i} className="validator-check-reason">• {r}</div>
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}
        {payload.status === "loading" && !results && (
          <div className="validator-check-row validator-check-row--pending">
            <StatusIcon status="pending" />
            <span className="validator-check-label">Analyzing...</span>
          </div>
        )}
      </div>
    </div>
  );
});
