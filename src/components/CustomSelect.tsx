import { useState, useRef, useEffect, useCallback } from "react";

interface Option {
  value: string;
  label: string;
  className?: string;
}

interface CustomSelectProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

const SEARCH_THRESHOLD = 10;

export function CustomSelect({ value, options, onChange, placeholder, className = "" }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const showSearch = options.length > SEARCH_THRESHOLD;
  const selectedOption = options.find((o) => o.value === value);

  const filtered = showSearch && query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const handleOpen = useCallback(() => {
    setOpen(true);
    setQuery("");
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleClose();
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      if (showSearch) {
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, showSearch, handleClose]);

  return (
    <div className={`custom-select ${className}`} ref={containerRef}>
      <div
        className={`custom-select-trigger ${open ? "open" : ""}`}
        onClick={() => (open ? handleClose() : handleOpen())}
      >
        <span className="custom-select-value">
          {selectedOption ? selectedOption.label : placeholder || "Select..."}
        </span>
        <span className="custom-select-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </span>
      </div>

      {open && (
        <div className="custom-select-dropdown">
          {showSearch && (
            <div className="custom-select-search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                ref={searchRef}
                type="text"
                className="custom-select-search-input"
                placeholder="Search..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") handleClose();
                  if (e.key === "Enter" && filtered.length > 0) {
                    onChange(filtered[0].value);
                    handleClose();
                  }
                }}
              />
              {query && (
                <button className="custom-select-search-clear" onClick={() => setQuery("")}>×</button>
              )}
            </div>
          )}
          <div className="custom-select-options">
            {filtered.length === 0 ? (
              <div className="custom-select-empty">No results</div>
            ) : (
              filtered.map((opt) => (
                <div
                  key={opt.value}
                  className={`custom-select-option ${opt.value === value ? "selected" : ""} ${opt.className || ""}`}
                  onClick={() => {
                    onChange(opt.value);
                    handleClose();
                  }}
                >
                  {opt.label}
                  {opt.value === value && (
                    <span className="custom-select-check">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
