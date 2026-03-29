import { cn } from "@/lib/utils";
import type { ChatMessage } from "@paperclipai/shared";
import { Bot, User } from "lucide-react";
import { ChatCard } from "./ChatCard";
import { MarkdownBody } from "../MarkdownBody";

interface ChatBubbleProps {
  message: ChatMessage;
  onCardAction?: (messageId: string, action: string, editedData?: unknown) => void;
  isCardActionPending?: boolean;
}

export function ChatBubble({ message, onCardAction, isCardActionPending }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-3 px-4 py-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="flex-shrink-0 mt-0.5">
          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
            <Bot className="h-4 w-4 text-primary" />
          </div>
        </div>
      )}
      <div className={cn("max-w-[80%] min-w-0 flex flex-col gap-2", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm",
            isUser
              ? "bg-primary text-primary-foreground rounded-br-md"
              : "bg-muted/60 text-foreground rounded-bl-md",
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <MarkdownBody>{message.content}</MarkdownBody>
          )}
        </div>
        {message.cardType && message.cardData && (
          <ChatCard
            messageId={message.id}
            cardType={message.cardType}
            cardData={message.cardData}
            cardState={message.cardState as Record<string, unknown> | null}
            onAction={onCardAction}
            isActionPending={isCardActionPending}
          />
        )}
        <span className="text-[11px] text-muted-foreground/60 px-1">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      {isUser && (
        <div className="flex-shrink-0 mt-0.5">
          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center">
            <User className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      )}
    </div>
  );
}
