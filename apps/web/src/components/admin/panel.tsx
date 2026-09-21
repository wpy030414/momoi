/**
 * Admin panel barrel — the single lazy-loading boundary for all admin UI.
 *
 * useAdminPanel dynamic-imports ONLY this module; everything below (sidebar +
 * main pane + all tab components) is statically wired and therefore bundled
 * into one chunk. Admins download the whole panel once on first open instead
 * of a scatter of per-tab chunks. Keep new admin components statically
 * imported from here rather than adding new lazy boundaries.
 */
export { AdminSidebar } from './AdminSidebar'
export { AdminPanelMain } from './AdminPanelMain'
