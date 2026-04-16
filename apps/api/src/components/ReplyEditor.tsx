import React, { useState, useEffect, useRef } from 'react';

interface ReplyEditorProps {
  value: string;
  onChange: (value: string) => void;
  ticketId: number;
}

const ReplyEditor: React.FC<ReplyEditorProps> = ({ value, onChange, ticketId }) => {
  const [text, setText] = useState(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      localStorage.setItem(`replyDraft-${ticketId}`, text);
    }, 1000);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [text, ticketId]);

  useEffect(() => {
    const saved = localStorage.getItem(`replyDraft-${ticketId}`);
    if (saved !== null && saved !== value) {
      setText(saved);
      onChange(saved);
    }
  }, [ticketId]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    onChange(e.target.value);
  };

  return (
    <textarea
      value={text}
      onChange={handleChange}
      placeholder="Type your reply here..."
      style={{ width: '100%', height: '100px' }}
    />
  );
};

export default ReplyEditor;
