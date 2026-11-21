import { accountsMain } from "./automagik-herdr.mjs";
import { HERE_V } from "../accountsHere.js";
import { WRITE_V } from "../accountsWrite.js";

process.exitCode = await accountsMain(process.argv.slice(2));
