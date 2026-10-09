import { createContext, useContext } from 'react';
import { normalizeAuthIndex } from '@/utils/quota';
import type { AuthFileItem } from '@/types';

/** Keeper notes worth showing on a row, by auth index. Routine notes are dropped upstream. */
export const ResetKeeperContext = createContext<Map<string, string>>(new Map());

/** The keeper's reasoning for this account, if it has anything to say. */
export function useResetKeeperNote(file: AuthFileItem): string | undefined {
  const notes = useContext(ResetKeeperContext);
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  return authIndex ? notes.get(authIndex) : undefined;
}

/** First clause of a note ("waiting", "resetting", ...) for tight cells. */
export const shortKeeperNote = (note: string) => note.split(/[,:(]/)[0].trim();

/** Notes that only repeat what the row already shows. */
export const isRoutineKeeperNote = (note: string) =>
  note.startsWith('weekly not used up') || note === 'no reset left';
