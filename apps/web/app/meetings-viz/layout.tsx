import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meeting Room — Arceus",
  description: "Round table meeting visualization",
};

export default function MeetingsVizLayout({ children }: { children: React.ReactNode }) {
  return children;
}
