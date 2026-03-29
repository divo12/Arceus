import { useState, useRef, useEffect } from "react";
import { Send, Square, BarChart3, ListPlus, UserPlus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const QUICK_ACTIONS = [
  { label: "Status Update", icon: BarChart3, message: "Give me a status briefing on the company." },
  { label: "New Task", icon: ListPlus, message: "I'd like to propose a new task." },
  { label: "Hire Agent", icon: UserPlus, message: "I want to hire a new agent." },
  { label: "Budget Review", icon: Wallet, message: "Give me a budget review." },
] as const;

interface ChatInputProps {
  onSend: (content: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function ChatInput({ onSend, onCancel, isStreaming, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [value]);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setValue("");
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      {/* Quick-action chips */}
      {!isStreaming && (
        <div className="flex items-center gap-2 max-w-3xl mx-auto mb-2 overflow-x-auto">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              disabled={disabled}
              onClick={() => onSend(action.message)}
              className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border",
                "bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground",
                "hover:bg-accent hover:text-accent-foreground hover:border-accent",
                "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <action.icon className="h-3.5 w-3.5" />
              {action.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 max-w-3xl mx-auto">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the CEO…"
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-xl border border-input bg-muted/30 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/50",
            "focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "max-h-[200px] overflow-y-auto",
          )}
        />
        {isStreaming ? (
          <Button
            size="icon"
            variant="outline"
            className="h-10 w-10 rounded-xl shrink-0"
            onClick={onCancel}
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="h-10 w-10 rounded-xl shrink-0"
            onClick={handleSubmit}
            disabled={!value.trim() || disabled}
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
