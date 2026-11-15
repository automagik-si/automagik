// Exercise am's shipped copies independently in the am CI job.
import { startProgramsTests } from "../../herdr/test/start-programs.mjs";
startProgramsTests(new URL("../bin/automagik-herdr.mjs", import.meta.url).pathname);
