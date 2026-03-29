import { Bot } from "lucide-react";
import { MarkdownBody } from "../MarkdownBody";
import { ChatCard } from "./ChatCard";
import type { StreamingState } from "../../hooks/useChat";

interface ChatStreamingBubbleProps {
  streaming: StreamingState;
}

export function ChatStreamingBubble({ streaming }: ChatStreamingBubbleProps) {
  if (!streaming.isStreaming && !streaming.tokens) return null;

  return (
    <div className="flex gap-3 px-4 py-3 justify-start">
      <div className="flex-shrink-0 mt-0.5">
        <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="h-4 w-4 text-primary animate-pulse" />
        </div>
      </div>
      <div className="max-w-[80%] min-w-0 flex flex-col gap-2">
        {streaming.tokens ? (
          <div className="rounded-2xl px-4 py-2.5 text-sm bg-muted/60 text-foreground rounded-bl-md">
            <MarkdownBody>{streaming.tokens}</MarkdownBody>
            {streaming.isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom" />
            )}
          </div>
        ) : (
          <div className="rounded-2xl px-4 py-2.5 text-sm bg-muted/60 text-foreground rounded-bl-md">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="flex gap-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
              </span>
              Thinking…
            </span>
          </div>
        )}
        {streaming.cards.map((card, i) => (
          <ChatCard
            key={i}
            messageId={`streaming-${i}`}
            cardType={card.cardType}
            cardData={card.cardData}
            cardState={null}
          />
        ))}
      </div>
    </div>
  );
}
