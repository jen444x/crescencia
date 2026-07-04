import {
  useState,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

// useState that survives reloads by mirroring to localStorage: read the stored
// value once on mount, then write it back whenever it changes. Drop-in for
// useState — same [value, setValue] shape.
//
// `codec` controls how the value is stored and parsed, so each setting keeps its
// exact on-disk format (existing saved settings must round-trip unchanged, or a
// user loses their preference on deploy). Without one, values round-trip as JSON.
// A missing/empty key falls back to `initial`.
export function usePersistentState<T>(
  key: string,
  initial: T,
  codec?: { parse: (raw: string) => T; serialize: (value: T) => string },
): [T, Dispatch<SetStateAction<T>>] {
  const parse = codec?.parse ?? ((raw) => JSON.parse(raw) as T);
  const serialize = codec?.serialize ?? ((value: T) => JSON.stringify(value));

  // Keep the latest serialize in a ref (updated in an effect, never during
  // render) so the write effect below can depend on just [key, value]: a caller's
  // inline codec is a fresh function every render, and we want to touch
  // localStorage only when the value actually changes, not on every render.
  const serializeRef = useRef(serialize);
  useEffect(() => {
    serializeRef.current = serialize;
  });

  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    return raw == null ? initial : parse(raw);
  });
  useEffect(() => {
    localStorage.setItem(key, serializeRef.current(value));
  }, [key, value]);
  return [value, setValue];
}
