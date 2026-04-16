import React from 'react';

interface ReviewControlsProps {
  onSubmit: () => void;
  onDiscard: () => void;
  disabled: boolean;
}

const ReviewControls: React.FC<ReviewControlsProps> = ({ onSubmit, onDiscard, disabled }) => {
  return (
    <div className="review-controls" style={{ marginTop: '1rem' }}>
      <button onClick={onSubmit} disabled={disabled} style={{ marginRight: '1rem' }}>
        Submit
      </button>
      <button onClick={onDiscard}>
        Discard Changes
      </button>
    </div>
  );
};

export default ReviewControls;
