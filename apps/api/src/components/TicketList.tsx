import React from 'react';
import { Ticket } from '../types';

interface TicketListProps {
  tickets: Ticket[];
  selectedTicketId: number | null;
  onSelectTicket: (id: number) => void;
}

const TicketList: React.FC<TicketListProps> = ({ tickets, selectedTicketId, onSelectTicket }) => {
  return (
    <div className="ticket-list" style={{ backgroundColor: 'var(--color-light-background)', padding: '1rem', height: '100%' }}>
      {tickets.map(ticket => (
        <div 
          key={ticket.id} 
          className={`ticket-item ${ticket.id === selectedTicketId ? 'selected' : ''}`}
          onClick={() => onSelectTicket(ticket.id)}
          style={{
            padding: '0.5rem',
            marginBottom: '0.5rem',
            cursor: 'pointer',
            backgroundColor: ticket.id === selectedTicketId ? 'var(--color-primary-light)' : 'transparent'
          }}
        >
          <div className="ticket-subject" style={{ fontWeight: 'bold' }}>{ticket.subject}</div>
          <div className="ticket-status" style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>{ticket.status}</div>
        </div>
      ))}
    </div>
  );
};

export default TicketList;
