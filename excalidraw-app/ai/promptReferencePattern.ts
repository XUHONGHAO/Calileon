// Shared matcher for reference tokens (`#1`, `图 2`, `image 3`). Kept in one
// place so validation warnings, the inline highlight layer and the video
// adapters' prompt rewriting always agree on what counts as a reference.
// `#?` marks a token whose image was removed (see remapPromptReferences).
// Capture groups 1–3 hold the index for the `#`, `图` and `image` forms.
export const PROMPT_REFERENCE_PATTERN = /#(\d+)|图\s*(\d+)|image\s+(\d+)|#\?/gi;
