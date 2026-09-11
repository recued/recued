/** A consumed budget unit may finish its own attempt. This host-only context
 * is entered solely around that attempt's live authorization recheck, never
 * around a provider, nested operation, request, or new member claim. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isContractActive, type ContractDefinition } from '@recued/contracts';
import { canonicalJSONStringifyStrict } from '@recued/crypto';

const material = ({ uses_remaining: _uses, ...definition }: ContractDefinition): string => canonicalJSONStringifyStrict(definition);
interface Reservation { contract_id: string; definition: string }
const issued = new WeakMap<object, Reservation>();
const checking = new AsyncLocalStorage<Reservation | undefined>();

/** Only the atomic contract-store reservation path issues this token. */
export const issueContractDispatchReservation = (before: ContractDefinition, after: ContractDefinition): object => {
  if (before.contract_id !== after.contract_id || material(before) !== material(after)
    || (typeof before.uses_remaining === 'number' && (before.uses_remaining <= 0 || after.uses_remaining !== before.uses_remaining - 1))) {
    throw new Error('The contract use was not reserved for this attempt.');
  }
  const token = Object.freeze({});
  issued.set(token, { contract_id: before.contract_id, definition: material(before) });
  return token;
};
export const withContractDispatchReservation = <T>(token: object | undefined, check: () => T): T =>
  checking.run(token ? issued.get(token) : undefined, check);

/** Every hard lifecycle and grant check remains live. Only the already
 * consumed unit is credited while checking the exact in-flight attempt. */
export const isContractActiveForDispatchCheck = (definition: ContractDefinition, now: number): boolean => {
  if (isContractActive(definition, now)) return true;
  const reservation = checking.getStore();
  return reservation?.contract_id === definition.contract_id && reservation.definition === material(definition)
    && isContractActive({ ...definition, uses_remaining: 1 }, now);
};
