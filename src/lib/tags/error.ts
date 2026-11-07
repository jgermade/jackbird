/** An error the tag engine gave, by its code (`Error::code()` in `crates/tags`), or `engine-failed` when the module itself broke or did not load. */
export class TagError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TagError";
  }
}
