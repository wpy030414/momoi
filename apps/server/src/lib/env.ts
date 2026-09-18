// One-shot side-effect import that loads .env from the repo root so every
// other module sees process.env.* populated before their top-level reads.
import { config } from 'dotenv'
import { join } from 'node:path'
import { repoRoot } from './paths.js'

config({ path: join(repoRoot(), '.env') })