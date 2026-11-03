// How the React view reads the jq79 stores while React is still here: one
// value of a store, and a setter with useState's shape (a value, or a
// function of the current one). Reads go through $toRaw, so React only ever
// sees plain objects, whose identity changes when they are replaced. Goes
// away with React (ROADMAP/2026-11-03/deck-design-system.md, clean-up).

import { useCallback, useSyncExternalStore } from "react";
import { $toRaw } from "jq79";

type Subscribable = {
  $onAny: (listener: (dotKey: string, value: unknown) => void) => () => void;
};

export type SetValue<V> = (next: V | ((current: V) => V)) => void;

export function useStoreValue<T extends object, K extends keyof T & string>(store: T & Subscribable, key: K): [T[K], SetValue<T[K]>] {
  const subscribe = useCallback(
    (notify: () => void) =>
      store.$onAny((dotKey) => {
        if (dotKey === key || dotKey.startsWith(`${key}.`)) {
          notify();
        }
      }),
    [store, key]
  );
  const value = useSyncExternalStore(subscribe, () => ($toRaw(store) as T)[key]);

  const set = useCallback<SetValue<T[K]>>(
    (next) => {
      const current = ($toRaw(store) as T)[key];
      (store as T)[key] = typeof next === "function" ? (next as (current: T[K]) => T[K])(current) : next;
    },
    [store, key]
  );

  return [value, set];
}
