/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  /** The exact text copied to the clipboard. */
  value: string;
  className?: string;
  title?: string;
  size?: number;
}

/**
 * CopyButton — a tiny inline copy-to-clipboard control for ids and similar
 * short strings. Stops propagation so it works inside clickable rows. Shows a
 * brief ✓ on success; falls back to a prompt if the Clipboard API is blocked.
 */
export const CopyButton: React.FC<CopyButtonProps> = ({ value, className, title = 'Copy id', size = 11 }) => {
  const [copied, setCopied] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // eslint-disable-next-line no-alert
      window.prompt('Copy:', value);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? 'Copied!' : title}
      aria-label={title}
      className={cn('inline-flex items-center text-muted-foreground hover:text-foreground transition-colors align-middle', className)}
    >
      {copied ? <Check size={size} className="text-green-500" /> : <Copy size={size} />}
    </button>
  );
};

export default CopyButton;
