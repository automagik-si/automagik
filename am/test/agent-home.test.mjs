import { agentHomeTests } from "../../herdr/test/agent-home.mjs";
agentHomeTests(new URL("../bin/automagik-herdr.mjs", import.meta.url).pathname);
