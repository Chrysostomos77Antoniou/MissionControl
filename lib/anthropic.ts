import Anthropic from "@anthropic-ai/sdk";

// Server-only: instantiating the SDK client here means this file must never
// be imported by client components (or anything they import). Files that
// only need a model id string — including code shared with the frontend —
// should import from lib/models.ts instead, which has no side effects.
export { OPUS, SONNET, HAIKU, MODEL } from "./models";

export const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
