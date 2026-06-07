import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost";
};

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn("btn", variant === "secondary" && "btn-secondary", variant === "ghost" && "btn-ghost", className)}
      {...props}
    />
  );
}
