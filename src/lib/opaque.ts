/**
 * A derived value handed to views whole. jq79 passes class instances through
 * untouched, so the store that holds one never wraps it or compares it field
 * by field; a new box is simply a new value. Views read `.value.data` in their
 * bindings and never copy it into a store variable.
 */
export class Opaque<T> {
  constructor(readonly data: T) {}
}
