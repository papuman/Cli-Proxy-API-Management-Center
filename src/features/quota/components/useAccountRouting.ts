import { useContext } from 'react';
import type { QuotaFileEntry } from '../logic';
import { RoutingContext } from '../routingContext';
import styles from './AccountRouting.module.scss';

/** Whether this account is in use / pinned, and the class that marks its row. */
export function useAccountRouting(entry: QuotaFileEntry) {
  const routing = useContext(RoutingContext);
  const live = Boolean(routing) && !entry.file.disabled;
  const requests = live ? routing?.inUse.get(entry.file.name) : undefined;
  const pinned = live && routing?.pinned.get(entry.type) === entry.file.name;
  const inUse = requests !== undefined;
  return {
    routing,
    requests,
    inUse,
    pinned,
    rowClass: [inUse ? styles.inUseRow : '', pinned ? styles.pinnedRow : ''].join(' '),
  };
}
