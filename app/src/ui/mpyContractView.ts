/**
 * TBI-005: the MicroPython support contract as the panel lists it. The data is
 * runtime/builder/pyContract.ts itself (never copied); this only orders it into sections.
 */
import {
  MICROPYTHON_CONTRACT,
  type ContractEntry,
  type ContractStatus,
} from '../../../runtime/builder/pyContract.js';

/** Section order; every contract status must be listed here (a test checks it). */
export const SUPPORT_SECTIONS: readonly ContractStatus[] = ['supported', 'refused', 'unknown'];

/** The entries of one status, in contract order. */
export function entriesWithStatus(status: ContractStatus): ContractEntry[] {
  return MICROPYTHON_CONTRACT.filter((e) => e.status === status);
}
