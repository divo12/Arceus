import React, { useState, useEffect } from "react";
import { Text } from "ink";

const DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % DOTS.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text>{DOTS[frame]}</Text>;
}
