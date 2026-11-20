// A worker on a chosen agent home (#1208), against the pack's own CLI (agent-home.mjs).
import { agentHomeTests } from "./agent-home.mjs";
agentHomeTests(new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname);
