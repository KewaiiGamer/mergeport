"use client";

import * as D from "@radix-ui/react-dialog";
import { createContext, useContext, useState, type ReactNode } from "react";
import { X } from "./icons";

const SheetCloseContext = createContext<(() => void) | null>(null);
/** Closes the Sheet this component is rendered in; null outside a Sheet. A form uses it to close the dialog once its action succeeded. */
export const useSheetClose = () => useContext(SheetCloseContext);

/**
 * Accessible modal: named, focus-trapped, focus restored to the trigger on close, Escape closes.
 * CSS owns the open/close motion (opacity + transform); nothing waits on it before the user can act.
 */
export function Sheet({ trigger, title, description, children, side = "center" }: { trigger: ReactNode; title: string; description?: string; children: ReactNode; side?: "center" | "right" }) {
  const [open, setOpen] = useState(false);
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Trigger asChild>{trigger}</D.Trigger>
      <D.Portal>
        <D.Overlay className="scrim fixed inset-0 z-40 bg-scrim" />
        <D.Content
          className={
            side === "right"
              ? "drawer fixed inset-y-0 right-0 z-50 w-[min(420px,100vw)] overflow-y-auto border-l border-line bg-surface p-5 shadow-pop"
              : "sheet fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-line bg-surface p-5 shadow-pop"
          }
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-[16px] font-medium text-ink">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-[13px] text-ink-3">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="btn btn-quiet btn-icon -mr-1.5" aria-label="Close">
              <X size={16} aria-hidden />
            </D.Close>
          </div>
          <SheetCloseContext.Provider value={() => setOpen(false)}>{children}</SheetCloseContext.Provider>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
