import React from "react";
import { cn } from "../../utils";

export function ScrollArea({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("overflow-y-auto overflow-x-hidden scrollbar-thin", className)}
      {...props}
    >
      {children}
    </div>
  );
}
