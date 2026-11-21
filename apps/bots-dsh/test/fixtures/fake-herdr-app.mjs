#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

appendFileSync(process.env.FAKE_HERDR_APP_LOG, JSON.stringify(process.argv.slice(2)) + '\n')
