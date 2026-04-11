"use client";

import { useState, useRef, useCallback } from "react";
import { Info } from "lucide-react";

interface InfoTooltipProps {
  text: string;
}

const TOOLTIP_HEIGHT = 34; // approximate px height for a single-line tooltip

export function InfoTooltip({ text }: InfoTooltipProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (!iconRef.current) return;
    const r = iconRef.current.getBoundingClientRect();
    setPos({
      top:  r.top - TOOLTIP_HEIGHT - 8,
      left: r.left + r.width / 2,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setPos(null);
  }, []);

  return (
    <>
      <span
        ref={iconRef}
        className="inline-flex cursor-default items-center"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <Info size={13} className="text-gray-400" />
      </span>

      {pos && (
        <span
          role="tooltip"
          style={{
            position:        "fixed",
            top:             pos.top,
            left:            pos.left,
            transform:       "translateX(-50%)",
            backgroundColor: "#1F2937",
            color:           "#ffffff",
            fontSize:        "11px",
            fontWeight:      400,
            lineHeight:      "1.4",
            borderRadius:    "6px",
            padding:         "5px 10px",
            maxWidth:        "180px",
            width:           "max-content",
            whiteSpace:      "normal",
            textTransform:   "none",
            letterSpacing:   "normal",
            zIndex:          9999,
            pointerEvents:   "none",
          }}
        >
          {text}
          {/* Arrow pointing down toward the icon */}
          <span
            style={{
              position:    "absolute",
              top:         "100%",
              left:        "50%",
              transform:   "translateX(-50%)",
              width:       0,
              height:      0,
              borderLeft:  "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop:   "5px solid #1F2937",
            }}
          />
        </span>
      )}
    </>
  );
}
