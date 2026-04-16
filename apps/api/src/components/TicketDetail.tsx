import React, { useEffect, useState, useCallback } from 'react';
import LoadingIndicator from './LoadingIndicator';
import ErrorNotification from './ErrorNotification';
import ReplyEditor from './ReplyEditor';
import ReviewControls from './ReviewControls';
import { TicketDetailData } from '../types';

const ZENDESK_API_BASE = 'https://your-zendesk-domain.zendesk.com/api/v2'; // Replace with actual Zendesk domain

interface TicketDetailProps {
  ticketId: number;
}

const TicketDetail: React.FC<TicketDetailProps> = ({ ticketId }) => {
  const [detail, setDetail] = useState<TicketDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [aiSuggestion, setAiSuggestion] = useState('');
  const [replyEdited, setReplyEdited] = useState(false);

  const fetchTicketDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${ZENDESK_API_BASE}/tickets/${ticketId}/comments.json`, {
        headers: { 'Authorization': 'Basic ' + btoa('your_email/token:your_token'), 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch ticket detail: ${response.statusText}`);
      }
      const data = await response.json();
      // Assume the comments include conversation, AI summary, and AI suggested reply
      // Here we parse and build the detail data accordingly
      const conversation = data.comments || [];
      // For demonstration, AI summary and AI suggested reply are dummy
      const aiSummary = data.ai_summary || '';
      const aiSuggestedReply = data.ai_suggested_reply || '';

      setDetail({ conversation, aiSummary, aiSuggestedReply });
      setReply(aiSuggestedReply);
      setAiSuggestion(aiSuggestedReply);
      setReplyEdited(false);
    } catch (err: any) {
      setError(err.message || 'Unknown error fetching ticket detail');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    fetchTicketDetail();
  }, [fetchTicketDetail]);

  const handleReplyChange = (value: string) => {
    setReply(value);
    setReplyEdited(value !== aiSuggestion);
  };

  const handleDiscard = () => {
    setReply(aiSuggestion);
    setReplyEdited(false);
  };

  const handleSubmit = async () => {
    if (!replyEdited) return;
    setLoading(true);
    setError(null);
    try {
      const postData = { body: reply };
      const response = await fetch(`${ZENDESK_API_BASE}/tickets/${ticketId}/comments.json`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa('your_email/token:your_token'), 'Content-Type': 'application/json' },
        body: JSON.stringify(postData),
      });
      if (!response.ok) {
        throw new Error(`Failed to submit reply: ${response.statusText}`);
      }
      // Refresh ticket detail to show submitted reply
      await fetchTicketDetail();
    } catch (err: any) {
      setError(err.message || 'Unknown error submitting reply');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <LoadingIndicator />;
  if (error) return <ErrorNotification message={error} />;

  if (!detail) return <div style={{ padding: '1rem' }}>Select a ticket to view details.</div>;

  return (
    <div style={{ padding: '1rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '1 1 auto', overflowY: 'auto', marginBottom: '1rem' }}>
        <h2>Conversation</h2>
        <div className="conversation" style={{ maxHeight: '60vh', overflowY: 'auto', marginBottom: '1rem' }}>
          {detail.conversation.map((comment, idx) => (
            <div key={comment.id || idx} style={{ marginBottom: '0.5rem', borderBottom: '1px solid var(--color-border)', paddingBottom: '0.5rem' }}>
              <div style={{ fontWeight: 'bold' }}>{comment.author_id}</div>
              <div>{comment.body}</div>
            </div>
          ))}
        </div>
        <h3>AI Summary</h3>
        <div style={{ marginBottom: '1rem', fontStyle: 'italic', color: 'var(--color-text-secondary)' }}>{detail.aiSummary}</div>
      </div>
      <div style={{ flex: '0 0 auto' }}>
        <ReplyEditor
          value={reply}
          onChange={handleReplyChange}
          ticketId={ticketId}
        />
        <ReviewControls
          onSubmit={handleSubmit}
          onDiscard={handleDiscard}
          disabled={!replyEdited}
        />
      </div>
    </div>
  );
};

export default TicketDetail;
