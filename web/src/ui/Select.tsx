import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function Select({ value, options, onChange, disabled, className }: SelectProps): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const activeIndex = options.findIndex((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown": {
        e.preventDefault();
        const next = activeIndex < options.length - 1 ? activeIndex + 1 : 0;
        onChange(options[next].value);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = activeIndex > 0 ? activeIndex - 1 : options.length - 1;
        onChange(options[prev].value);
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        close();
        break;
    }
  };

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  return (
    <div
      ref={ref}
      className={`custom-select${open ? " open" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        className="custom-select-trigger"
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={handleKeyDown}
      >
        <span className="custom-select-value">{selectedLabel}</span>
        <span className="custom-select-chevron" aria-hidden="true">
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && (
        <ul ref={listRef} role="listbox" className="custom-select-list">
          {options.map((option) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`custom-select-option${option.value === value ? " selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                close();
              }}
              onMouseEnter={() => {
                const el = listRef.current?.children[options.indexOf(option)] as HTMLElement;
                el?.scrollIntoView({ block: "nearest" });
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
