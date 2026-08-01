declare module "jsmediatags/dist/jsmediatags.min.js" {
  const jsmediatags: {
    read: (
      file: File,
      handlers: {
        onSuccess: (result: { tags: Record<string, unknown> }) => void;
        onError: (error: unknown) => void;
      }
    ) => void;
  };

  export default jsmediatags;
}
