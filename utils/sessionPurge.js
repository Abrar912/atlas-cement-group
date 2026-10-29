'use strict';
/**
 * M6 — server-side session invalidation (password change / credential recovery).
 *
 * When a password changes, every existing server-side session belonging to that
 * user must be destroyed so hijacked or stale sessions can no longer act. The
 * session that performed the change (keepSid) is preserved so the legitimate
 * actor is not logged out mid-flow.
 *
 * connect-sqlite3's Store.all() drops the sid, so we read the raw table
 * (sid, sess), parse the JSON and match user_id precisely — never by LIKE.
 *
 * Usage: purgeUserSessions(req.sessionStore, userId, keepSidOrNull, callback)
 * callback(err, destroyedCount). Failures never break the caller's response —
 * the password change already succeeded; a purge error is logged, not thrown.
 */

function purgeUserSessions(store, userId, keepSid, cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    if (!store || !store.db || typeof store.db.all !== 'function' || typeof store.destroy !== 'function') {
        return done(null, 0);
    }
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return done(null, 0);

    const rawTable = store.table || 'sessions';
    // Table name comes from config, not user input; validate defensively anyway.
    const table = /^[A-Za-z0-9_]+$/.test(rawTable) ? rawTable : 'sessions';

    store.db.all('SELECT sid, sess FROM ' + table, function (err, rows) {
        if (err) {
            console.error('[SESSION PURGE] read failed:', err.message);
            return done(err, 0);
        }
        const sids = [];
        for (const row of (rows || [])) {
            if (keepSid && row.sid === keepSid) continue;
            let sess = null;
            try { sess = JSON.parse(row.sess); } catch (e) { continue; }
            if (sess && Number(sess.user_id) === uid) sids.push(row.sid);
        }
        if (sids.length === 0) return done(null, 0);

        let pending = sids.length;
        let firstErr = null;
        sids.forEach(function (sid) {
            store.destroy(sid, function (derr) {
                if (derr && !firstErr) firstErr = derr;
                pending -= 1;
                if (pending === 0) {
                    if (firstErr) console.error('[SESSION PURGE] destroy failed for some sessions:', firstErr.message);
                    done(firstErr, sids.length);
                }
            });
        });
    });
}

/**
 * Convenience: keep the current browser session only if it belongs to the
 * account whose other sessions are being purged.
 */
function keepSidFor(req, userId) {
    if (req && req.session && req.sessionID && Number(req.session.user_id) === Number(userId)) {
        return req.sessionID;
    }
    return null;
}

module.exports = { purgeUserSessions, keepSidFor };
