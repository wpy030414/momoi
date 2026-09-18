// Stand-alone mode (--stand-alone CLI flag): single-user, zero-Momoi-auth
// local deployment. This is a zero-import leaf module on purpose: in ESM a
// dependency's body evaluates before the importing module's body, so no matter
// who imports this first (db.ts runs top-level-await DB init on import), the
// flag is resolved from process.argv before any consumer reads it.
export const STAND_ALONE = process.argv.includes('--stand-alone')
