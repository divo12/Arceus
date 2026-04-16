import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";
const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap text-[0.8125rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40", {
    variants: {
        variant: {
            default: "bg-[var(--swiss-black)] text-[var(--swiss-white)] hover:bg-[var(--swiss-gray-500)]",
            secondary: "bg-[var(--swiss-gray-50)] text-[var(--swiss-black)] hover:bg-[var(--swiss-gray-100)]",
            outline: "border border-[var(--swiss-gray-200)] bg-transparent hover:bg-[var(--swiss-gray-50)]",
            ghost: "hover:bg-[var(--swiss-gray-50)]"
        },
        size: {
            default: "h-9 px-4 py-2",
            sm: "h-8 px-3 text-xs",
            lg: "h-10 px-6"
        }
    },
    defaultVariants: {
        variant: "default",
        size: "default"
    }
});
const Button = React.forwardRef(({ className, variant, size, ...props }, ref) => {
    return _jsx("button", { className: cn(buttonVariants({ variant, size, className })), ref: ref, ...props });
});
Button.displayName = "Button";
export { Button, buttonVariants };
