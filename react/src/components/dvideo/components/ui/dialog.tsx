import React from "react";
import { cn } from "../../utils";
import { X } from "lucide-react";

interface DialogContextType {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextType | null>(null);

export function Dialog({
  children,
  open,
  onOpenChange,
}: {
  children: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogContext.Provider value={{ open, onOpenChange }}>
      {children}
    </DialogContext.Provider>
  );
}

export function DialogTrigger({
  render,
  children,
}: {
  render?: React.ReactElement<any>;
  children?: React.ReactNode;
}) {
  const ctx = React.useContext(DialogContext);
  if (!ctx) return null;

  if (render && React.isValidElement(render)) {
    return React.cloneElement(render, {
      onClick: (e: React.MouseEvent) => {
        (render.props as any)?.onClick?.(e);
        ctx.onOpenChange(!ctx.open);
      },
    });
  }

  return (
    <div onClick={() => ctx.onOpenChange(!ctx.open)} className="cursor-pointer">
      {children}
    </div>
  );
}

export function DialogContent({
  className,
  children,
  container,
}: {
  className?: string;
  children: React.ReactNode;
  container?: HTMLElement | null;
}) {
  const ctx = React.useContext(DialogContext);
  if (!ctx || !ctx.open) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 pointer-events-auto"
      onClick={() => ctx.onOpenChange(false)}
    >
      <div
        className={cn(
          "relative bg-zinc-950 border border-white/10 text-white rounded-2xl max-w-sm w-full p-6 shadow-2xl",
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => ctx.onOpenChange(false)}
          className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors cursor-pointer"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("flex flex-col gap-1", className)}>{children}</div>;
}

export function DialogTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <h3 className={cn("text-base font-bold", className)}>{children}</h3>;
}

export function DialogDescription({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <p className={cn("text-xs text-white/60", className)}>{children}</p>;
}
