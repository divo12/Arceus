import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import { cn } from "../../lib/utils";
const Textarea = React.forwardRef(({ className, ...props }, ref) => {
    return (_jsx("textarea", { className: cn("flex min-h-[100px] w-full border border-[var(--swiss-gray-200)] bg-transparent px-3 py-2 text-[0.8125rem] placeholder:text-[var(--swiss-gray-300)] focus-visible:outline-none focus-visible:border-[var(--swiss-black)] disabled:cursor-not-allowed disabled:opacity-40", className), ref: ref, ...props }));
});
Textarea.displayName = "Textarea";
export { Textarea };
