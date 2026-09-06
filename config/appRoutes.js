/**
 * Where the app sends people.
 *
 * USER_HOME was written out as a literal string in four places (the password
 * login, the Google callback, the "already signed in" redirect on /, and the
 * diagnostics script). Changing the landing page meant finding all four, and
 * missing one meant a user who signed in with Google ended up somewhere
 * different from a user who signed in with a password.
 */

/** The first page a signed-in student sees. */
export const USER_HOME = '/views/file-page-forme.html';

/** The first page a signed-in admin sees. */
export const ADMIN_HOME = '/admin-dashboard';

/**
 * Pages that no longer exist, and where their traffic should go instead.
 * Anything still linking to the old URL - a bookmark, an old tab, a phone's
 * home-screen shortcut - lands somewhere sensible rather than on a 404.
 */
export const RETIRED_PAGES = {
    '/views/User-Dashboard.html': USER_HOME,
    // File-page.html was a third listing page beside "For Me" and "My Files",
    // and having three entrances to the same files is one more than anybody
    // can hold in their head: the navbar's file icon led here, the tabs led
    // to the other two, and which one you were looking at was anyone's guess.
    // "For Me" is the landing page after sign-in and now the only file
    // entrance; "My Files" is one tap away from it, where it belongs.
    '/views/File-page.html': USER_HOME
};

export default { USER_HOME, ADMIN_HOME, RETIRED_PAGES };
