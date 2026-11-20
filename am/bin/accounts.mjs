import { accountsMain } from "./automagik-herdr.mjs";
import { HERE_V } from "../accountsHere.js";

process.exitCode = await accountsMain(process.argv.slice(2));
