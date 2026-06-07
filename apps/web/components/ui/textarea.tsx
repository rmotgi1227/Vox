import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={cn("textarea", className)} />;
}
