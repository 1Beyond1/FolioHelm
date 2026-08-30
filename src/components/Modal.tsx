import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  children: ReactNode;
  className: string;
  backdropClassName?: string;
  labelledBy?: string;
  describedBy?: string;
  ariaLabel?: string;
  testId?: string;
  closeOnBackdrop?: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

/**
 * Shared dialog boundary for every transient layer in the app.
 *
 * It deliberately owns only interaction mechanics: Escape, backdrop closing,
 * focus trapping, and focus restoration. The feature keeps ownership of its
 * visual language and business state.
 */
export function Modal({
  children,
  className,
  backdropClassName,
  labelledBy,
  describedBy,
  ariaLabel,
  testId,
  closeOnBackdrop = true,
  onClose,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    if (!dialog) return undefined;

    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable()[0];
    (first ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div
      className={backdropClassName}
      role="presentation"
      data-testid={testId ? `${testId}-backdrop` : undefined}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={ariaLabel}
        tabIndex={-1}
        data-testid={testId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
