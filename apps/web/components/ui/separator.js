import { jsx as _jsx } from "react/jsx-runtime";
import { cn } from "../../lib/utils";
function Separator({ className, ...props }) {
    return _jsx("div", { className: cn("h-px w-full bg-[var(--swiss-gray-100)]", className), ...props });
}
export { Separator };
