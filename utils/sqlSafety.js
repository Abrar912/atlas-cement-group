'use strict';

// L-finding: user input bound into SQL LIKE patterns keeps its wildcard meaning
// (`%` = match-all, `_` = match-one), letting a search box bypass intended filters
// (e.g. searching "%" returns every row). Escaping the input restores literal
// matching; callers must pair these params with `LIKE ? ESCAPE '\'`.

function escapeLike(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[\\%_]/g, (m) => '\\' + m);
}

// Contains-pattern: `%escaped%` (drop-in replacement for `%${term}%`).
function likeContains(value) {
    return '%' + escapeLike(value) + '%';
}

// Prefix-pattern: `escaped%` (drop-in replacement for `${prefix}%`).
function likePrefix(value) {
    return escapeLike(value) + '%';
}

module.exports = { escapeLike, likeContains, likePrefix };
