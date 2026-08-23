/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  actions?: React.ReactNode;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ items, actions }) => {
  return (
    <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
        <Link to="/" className="hover:text-foreground transition-colors">
          <Home size={12} />
        </Link>
        {items.map((item, i) => (
          <React.Fragment key={i}>
            <ChevronRight size={10} className="opacity-40" />
            {item.href ? (
              <Link to={item.href} className="hover:text-foreground transition-colors truncate max-w-[200px]">
                {item.label}
              </Link>
            ) : (
              <span className="text-foreground font-medium truncate max-w-[200px]">{item.label}</span>
            )}
          </React.Fragment>
        ))}
      </nav>
      {actions && <div className="flex items-center gap-3 flex-wrap justify-end">{actions}</div>}
    </div>
  );
};
