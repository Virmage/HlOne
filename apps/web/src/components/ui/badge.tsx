import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--hl-green)]/20 text-[var(--hl-green)]",
        secondary: "border-transparent bg-[var(--hl-surface)] text-[var(--hl-text)]",
        destructive: "border-transparent bg-red-600/20 text-red-400",
        outline: "border-[var(--hl-border)] text-[var(--hl-text)]",
        warning: "border-transparent bg-yellow-600/20 text-yellow-400",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
