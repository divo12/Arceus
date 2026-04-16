import { jsx as _jsx } from "react/jsx-runtime";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";
const badgeVariants = cva("inline-flex items-center border px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-[0.06em] transition-colors", {
    variants: {
        variant: {
            default: "border-[var(--swiss-black)] bg-[var(--swiss-black)] text-[var(--swiss-white)]",
            secondary: "border-[var(--swiss-gray-100)] bg-[var(--swiss-gray-50)] text-[var(--swiss-black)]",
            outline: "border-[var(--swiss-gray-200)] text-[var(--swiss-gray-500)]",
            destructive: "border-[var(--swiss-red)] bg-[var(--swiss-red)] text-white",
            warning: "border-[var(--swiss-black)] bg-[var(--swiss-white)] text-[var(--swiss-black)]"
        }
    },
    defaultVariants: {
        variant: "default"
    }
});
function Badge({ className, variant, ...props }) {
    return _jsx("div", { className: cn(badgeVariants({ variant }), className), ...props });
}
export { Badge, badgeVariants };
