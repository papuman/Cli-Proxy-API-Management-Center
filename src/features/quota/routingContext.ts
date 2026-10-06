import { createContext } from 'react';
import type { QuotaFileEntry } from './logic';
import type { RoutingState } from './routing';

export type RoutingContextValue = RoutingState & {
  busy: boolean;
  canEdit: boolean;
  onPin: (entry: QuotaFileEntry) => void;
  onUnpin: (type: string) => void;
  onRename: (entry: QuotaFileEntry, alias: string) => Promise<void>;
};

/** QuotaPage provides it; the routing pieces read it in every layout. */
export const RoutingContext = createContext<RoutingContextValue | null>(null);
